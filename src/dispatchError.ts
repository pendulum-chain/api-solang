import { DispatchError } from "@polkadot/types/interfaces";

export function extractDispatchErrorDescription(dispatchError: DispatchError): string {
  if (dispatchError.isModule) {
    try {
      const module = dispatchError.asModule;
      const error = dispatchError.registry.findMetaError(module);

      if (error.docs.length === 0) {
        return `${error.section}.${error.name}`;
      } else {
        return `${error.section}.${error.name}: ${error.docs[0]}`;
      }
    } catch {}
  }

  return dispatchError.type.toString();
}
