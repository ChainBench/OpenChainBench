import { useSyncExternalStore } from "react";

const noSubscription = () => () => {};

export const useHydrated = (): boolean =>
  useSyncExternalStore(noSubscription, () => true, () => false);
