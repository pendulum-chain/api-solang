import { AccountId32, DispatchError, DispatchInfo, EventRecord } from "@polkadot/types/interfaces";
import { AddressOrPair, SignerOptions, SubmittableExtrinsic } from "@polkadot/api/types";
import { ISubmittableResult, Signer } from "@polkadot/types/types";
import { INumber, ITuple } from "@polkadot/types-codec/types";
import { KeyringPair } from "@polkadot/keyring/types";

import { extractDispatchErrorDescription } from "./dispatchError.js";
import { Address } from "./index.js";

export type Extrinsic = SubmittableExtrinsic<"promise", ISubmittableResult>;

export type SubmitExtrinsicStatus = { type: "success" } | { type: "error"; error: string };

export interface SubmitExtrinsicResult {
  transactionFee: bigint | undefined;
  eventRecords: EventRecord[];
  status: SubmitExtrinsicStatus;
}

export interface KeyPairSigner {
  type: "keypair";
  keypair: KeyringPair;
}

export interface GenericSigner {
  type: "signer";
  address: Address;
  signer: Signer;
}

export function getSignerAddress(signer: KeyPairSigner | GenericSigner) {
  switch (signer.type) {
    case "keypair":
      return signer.keypair.address;

    case "signer":
      return signer.address;
  }
}

export async function submitAndSignExtrinsic(
  extrinsic: Extrinsic,
  signer: KeyPairSigner | GenericSigner
): Promise<SubmitExtrinsicResult> {
  let account: AddressOrPair;
  let signerOptions: Partial<SignerOptions>;

  switch (signer.type) {
    case "keypair":
      account = signer.keypair;
      signerOptions = { nonce: -1 };
      break;

    case "signer":
      account = signer.address;
      signerOptions = { nonce: -1, signer: signer.signer };
      break;
  }
  const signedExtrinsic = await extrinsic.signAsync(account, signerOptions);
  return submitExtrinsic(signedExtrinsic);
}

export async function submitExtrinsic(extrinsic: Extrinsic): Promise<SubmitExtrinsicResult> {
  return await new Promise<SubmitExtrinsicResult>(async (resolve, reject) => {
    try {
      const unsub = await extrinsic.send((update) => {
        const { status, events: eventRecords } = update;

        if (status.isInBlock || status.isFinalized) {
          let transactionFee: bigint | undefined = undefined;
          let status: SubmitExtrinsicStatus | undefined = undefined;

          for (const eventRecord of eventRecords) {
            const { data, section, method } = eventRecord.event;

            if (section === "transactionPayment" && method === "TransactionFeePaid") {
              const [, actualFee] = data as unknown as ITuple<[AccountId32, INumber, INumber]>;
              transactionFee = actualFee.toBigInt();
            }

            if (section === "system" && method === "ExtrinsicFailed") {
              const [dispatchError] = data as unknown as ITuple<[DispatchError, DispatchInfo]>;
              status = { type: "error", error: extractDispatchErrorDescription(dispatchError) };
            }

            if (section === "system" && method === "ExtrinsicSuccess") {
              status = { type: "success" };
            }
          }

          if (status !== undefined) {
            unsub();
            resolve({ transactionFee, eventRecords, status });
          }
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}
