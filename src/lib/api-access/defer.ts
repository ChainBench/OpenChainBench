export type Defer = (work: () => Promise<void>) => void;
