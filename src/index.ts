import { ApiPromise } from "@polkadot/api";
import { BN_ZERO } from "@polkadot/util";
import { ContractPromise } from "@polkadot/api-contract";
import { EventRecord, Weight } from "@polkadot/types/interfaces";
import { AnyJson } from "@polkadot/types-codec/types";
import { Abi } from "@polkadot/api-contract";
import { AddressOrPair, SignerOptions } from "@polkadot/api/types";

import { PanicCode, rpcCall } from "./contractRpc.js";
import {
  Extrinsic,
  GenericSigner,
  KeyPairSigner,
  SubmitExtrinsicStatus,
  SubmitExtrinsicResult,
  submitAndSignExtrinsic,
  submitExtrinsic,
} from "./submitExtrinsic.js";
import { addressEq } from "@polkadot/util-crypto";
import { basicDeployContract } from "./deployContract.js";

export {
  PanicCode,
  Extrinsic,
  GenericSigner,
  KeyPairSigner,
  SubmitExtrinsicStatus,
  SubmitExtrinsicResult,
  submitAndSignExtrinsic as submitExtrinsic,
};

export type Address = string;

export interface Limits {
  gas: {
    refTime: string | number;
    proofSize: string | number;
  };
  storageDeposit?: string | number;
}

export interface DecodedContractEvent {
  eventIdentifier: string;
  args: { name: string; value: AnyJson }[];
}

export interface ContractEvent {
  emittingContractAddress: Address;
  data: Uint8Array;
  decoded?: DecodedContractEvent;
}

export interface DeployContractOptions {
  abi: Abi;
  api: ApiPromise;
  signer: KeyPairSigner | GenericSigner;
  constructorArguments: unknown[];
  constructorName?: string;
  limits: Limits;
  modifyExtrinsic?: (extrinsic: Extrinsic) => Extrinsic;
  lookupAbi?: (contractAddress: Address) => Abi | undefined;
}

export type DeployContractResult =
  | { type: "success"; events: ContractEvent[]; deploymentAddress: Address; transactionFee: bigint | undefined }
  | { type: "error"; error: string }
  | { type: "reverted"; description: string }
  | { type: "panic"; errorCode: PanicCode; explanation: string };

export interface CreateExecuteMessageExtrinsicOptions {
  abi: Abi;
  api: ApiPromise;
  contractDeploymentAddress: Address;
  callerAddress: Address;
  messageName: string;
  messageArguments: unknown[];
  limits: Limits;
  gasLimitTolerancePercentage?: number;
}

export type CreateExecuteMessageExtrinsicResult = {
  execution: { type: "onlyRpc" } | { type: "extrinsic"; extrinsic: Extrinsic };
  result: ReadMessageResult;
};

export interface ExecuteMessageOptions extends CreateExecuteMessageExtrinsicOptions {
  getSigner: () => Promise<KeyPairSigner | GenericSigner>;
  modifyExtrinsic?: (extrinsic: Extrinsic) => Extrinsic;
  lookupAbi?: (contractAddress: Address) => Abi | undefined;
}

export type ExecuteMessageResult = {
  execution:
    | { type: "onlyRpc" }
    | { type: "extrinsic"; contractEvents: ContractEvent[]; transactionFee: bigint | undefined };
  result: ReadMessageResult;
};

export interface ReadMessageOptions {
  abi: Abi;
  api: ApiPromise;
  contractDeploymentAddress: Address;
  callerAddress: Address;
  messageName: string;
  messageArguments: unknown[];
  limits: Limits;
}

export type GasMetrics = {
  gasRequired: Weight;
  gasConsumed: Weight;
};

export type ReadMessageResult =
  | { type: "success"; gasMetrics: GasMetrics; value: any }
  | { type: "error"; gasMetrics: GasMetrics; error: string }
  | { type: "reverted"; gasMetrics: GasMetrics; description: string }
  | { type: "panic"; gasMetrics: GasMetrics; errorCode: PanicCode; explanation: string };

function decodeContractEvents(
  eventRecords: EventRecord[],
  lookupAbi?: (contractAddress: Address) => Abi | undefined
): ContractEvent[] {
  return eventRecords
    .filter(({ event: { section, method } }) => section === "contracts" && method === "ContractEmitted")
    .map((eventRecord): ContractEvent => {
      const dataJson = eventRecord.event.data.toHuman() as { contract: string; data: string };
      const emittingContractAddress = dataJson.contract;

      let dataHexString = dataJson.data;
      if (dataHexString.startsWith("0x")) dataHexString = dataHexString.slice(2);
      const data = new Uint8Array(dataHexString.length / 2);
      for (let i = 0; i * 2 < dataHexString.length; i += 1) {
        data[i] = parseInt(dataHexString.slice(i * 2, i * 2 + 2), 16);
      }

      const abi = lookupAbi?.(emittingContractAddress);
      if (abi === undefined) {
        return {
          emittingContractAddress,
          data,
        };
      }
      const decodedEvent = abi.decodeEvent(eventRecord);

      return {
        emittingContractAddress,
        data,
        decoded: {
          args: decodedEvent.event.args.map((arg, index) => ({
            name: arg.name,
            value: decodedEvent.args[index].toHuman(),
          })),
          eventIdentifier: decodedEvent.event.identifier,
        },
      };
    });
}

export async function deployContract({
  signer,
  api,
  abi,
  constructorArguments,
  constructorName,
  limits,
  modifyExtrinsic,
  lookupAbi,
}: DeployContractOptions): Promise<DeployContractResult> {
  const result = await basicDeployContract({
    api,
    abi,
    constructorArguments,
    constructorName,
    limits,
    signer,
    modifyExtrinsic,
  });

  switch (result.type) {
    case "panic":
    case "reverted":
    case "error":
      return result;
  }

  const extendedLookupAbi = (contractAddress: Address): Abi | undefined => {
    if (addressEq(contractAddress, result.deploymentAddress)) {
      return abi;
    }

    return lookupAbi?.(contractAddress);
  };

  return { ...result, events: decodeContractEvents(result.eventRecords, extendedLookupAbi) };
}

export async function executeMessage(options: ExecuteMessageOptions): Promise<ExecuteMessageResult> {
  const { getSigner, modifyExtrinsic, lookupAbi } = options;
  const { execution, result: readMessageResult } = await createExecuteMessageExtrinsic(options);

  if (execution.type === "onlyRpc") {
    return {
      execution,
      result: readMessageResult,
    };
  }

  let { extrinsic } = execution;
  if (modifyExtrinsic) {
    extrinsic = modifyExtrinsic(extrinsic);
  }

  const signer = await getSigner();
  const { eventRecords, status, transactionFee } = await submitAndSignExtrinsic(extrinsic, signer);

  return {
    execution: { type: "extrinsic", contractEvents: decodeContractEvents(eventRecords, lookupAbi), transactionFee },
    result: status.type === "success" ? readMessageResult : { ...status, gasMetrics: readMessageResult.gasMetrics },
  };
}

export async function createExecuteMessageExtrinsic({
  abi,
  api,
  contractDeploymentAddress,
  messageArguments,
  messageName,
  limits,
  callerAddress,
  gasLimitTolerancePercentage = 10,
}: ExecuteMessageOptions): Promise<CreateExecuteMessageExtrinsicResult> {
  const contract = new ContractPromise(api, abi, contractDeploymentAddress);

  let readMessageResult = await readMessage({
    api,
    abi,
    contractDeploymentAddress,
    callerAddress,
    messageName,
    messageArguments,
    limits,
  });

  if (readMessageResult.type !== "success") {
    return { execution: { type: "onlyRpc" }, result: readMessageResult };
  }

  let gasRequired = readMessageResult.gasMetrics.gasRequired;
  if (gasLimitTolerancePercentage > 0) {
    gasRequired = api.createType("WeightV2", {
      refTime: (gasRequired.refTime.toBigInt() * (100n + BigInt(gasLimitTolerancePercentage))) / 100n,
      proofSize: (gasRequired.proofSize.toBigInt() * (100n + BigInt(gasLimitTolerancePercentage))) / 100n,
    });
  }

  const typesAddress = api.registry.createType("AccountId", contractDeploymentAddress);
  let extrinsic = api.tx.contracts.call(
    typesAddress,
    BN_ZERO,
    gasRequired,
    limits.storageDeposit,
    contract.abi.findMessage(messageName).toU8a(messageArguments)
  );

  return { execution: { type: "extrinsic", extrinsic }, result: readMessageResult };
}

export async function submitExecuteMessageExtrinsic(
  extrinsic: Extrinsic,
  lookupAbi?: (contractAddress: Address) => Abi | undefined
): Promise<{ contractEvents: ContractEvent[]; transactionFee: bigint | undefined; status: SubmitExtrinsicStatus }> {
  const { eventRecords, status, transactionFee } = await submitExtrinsic(extrinsic);

  return {
    contractEvents: decodeContractEvents(eventRecords, lookupAbi),
    transactionFee,
    status,
  };
}

export async function readMessage({
  abi,
  api,
  contractDeploymentAddress,
  callerAddress,
  messageName,
  messageArguments,
  limits,
}: ReadMessageOptions): Promise<ReadMessageResult> {
  const { gasRequired, gasConsumed, output } = await rpcCall({
    api,
    abi,
    contractAddress: contractDeploymentAddress,
    callerAddress,
    limits,
    messageName,
    messageArguments,
  });

  const gasMetrics = { gasRequired, gasConsumed };

  switch (output.type) {
    case "success":
    case "reverted":
    case "panic":
      return { ...output, gasMetrics };

    case "error":
      return {
        type: "error",
        error: output.description ?? "unknown",
        gasMetrics,
      };
  }
}
