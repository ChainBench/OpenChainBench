type Work = () => Promise<void>;

export function deferredWork() {
  const queued: Work[] = [];
  return {
    defer: (work: Work) => void queued.push(work),
    flush: async () => {
      for (const work of queued.splice(0)) await work();
    },
  };
}
