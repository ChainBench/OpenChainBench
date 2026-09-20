// One refresh from the command line (local checks, or a cron on a host
// without the scheduler): `pnpm refresh`.
import { refreshSnapshot } from "../lib/snapshot";

refreshSnapshot("cli")
  .then((r) => {
    console.log(JSON.stringify({ ran: r.ran, failed: r.failed, stoppedBy: r.stoppedBy, refreshedAt: r.snapshot.refreshedAt }, null, 2));
    process.exit(r.failed.length > 0 || r.stoppedBy ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
