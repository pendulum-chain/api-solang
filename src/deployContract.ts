import { ApiPromise } from "@polkadot/api";
import { CodePromise, Abi } from "@polkadot/api-contract";
import { AccountId, EventRecord, WeightV2 } from "@polkadot/types/interfaces";
import { ITuple } from "@polkadot/types-codec/types";

import { Limits, Address } from "./index.js";
import {
  Extrinsic,
  GenericSigner,
  KeyPairSigner,
  getSignerAddress,
  signAndSubmitExtrinsic,
} from "./submitExtrinsic.js";
import { PanicCode, rpcInstantiate } from "./contractRpc.js";

export interface BasicDeployContractOptions {
  api: ApiPromise;
  abi: Abi;
  constructorArguments: unknown[];
  constructorName?: string;
  limits: Limits;
  signer: KeyPairSigner | GenericSigner;
  skipDryRunning: boolean | undefined;
  modifyExtrinsic?: (extrinsic: Extrinsic) => Extrinsic;
}

export type BasicDeployContractResult =
  | {
      type: "success";
      eventRecords: EventRecord[];
      deploymentAddress: Address;
      transactionFee: bigint | undefined;
    }
  | { type: "error"; error: string }
  | { type: "reverted"; description: string }
  | { type: "panic"; errorCode: PanicCode; explanation: string };

export async function basicDeployContract({
  api,
  abi,
  constructorArguments,
  constructorName,
  limits,
  signer,
  skipDryRunning,
  modifyExtrinsic,
}: BasicDeployContractOptions): Promise<BasicDeployContractResult> {
  const code = new CodePromise(api, abi, undefined);

  constructorName = constructorName ?? "new";
  try {
    abi.findConstructor(constructorName);
  } catch {
    throw new Error(`Contract has no constructor called ${constructorName}`);
  }

  let gasRequired: WeightV2;
  if (skipDryRunning === true) {
    gasRequired = api.createType("WeightV2", limits.gas);
  } else {
    const rpcResult = await rpcInstantiate({
      api,
      abi,
      callerAddress: getSignerAddress(signer),
      constructorName,
      limits,
      constructorArguments,
    });

    const { output } = rpcResult;
    gasRequired = rpcResult.gasRequired;

    switch (output.type) {
      case "reverted":
      case "panic":
        return output;

      case "error":
        return { type: "error", error: output.description ?? "unknown" };
    }
  }

  const { storageDeposit: storageDepositLimit } = limits;

  let extrinsic = code.tx[constructorName]({ gasLimit: gasRequired, storageDepositLimit }, ...constructorArguments);

  if (modifyExtrinsic) {
    extrinsic = modifyExtrinsic(extrinsic);
  }
  const { eventRecords, status, transactionFee } = await signAndSubmitExtrinsic(extrinsic, signer);

  if (status.type === "error") {
    return {
      type: "error",
      error: `Contract could not be deployed: ${status.error}`,
    };
  }

  let deploymentAddress: Address | undefined = undefined;

  for (const eventRecord of eventRecords) {
    const { data, section, method } = eventRecord.event;

    if (section === "contracts" && method === "Instantiated") {
      const [, contract] = data as unknown as ITuple<[AccountId, AccountId]>;
      deploymentAddress = contract.toString() as Address;
    }
  }

  if (deploymentAddress === undefined) {
    return { type: "error", error: "Contract address not found" };
  }

  return { type: "success", deploymentAddress, eventRecords, transactionFee };
}
