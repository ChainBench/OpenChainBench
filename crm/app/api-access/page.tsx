import Link from "next/link";
import { Shell } from "@/components/shell";
import { plural } from "@/components/ui";
import { type Listed, type SiteFailure, accessClient } from "@/lib/api-access";
import {
  type AccessStatus,
  DECLINED_KEPT,
  DECLINED_KEPT_DAYS,
  MAX_PENDING,
} from "@/lib/api-access-contract/contract";
import { readSnapshot } from "@/lib/snapshot";
import { parseWindow, withWindow } from "@/lib/window";
import { AccessBoard } from "./access-board";
import { MUTED, WarnPanel } from "./board-ui";
import { RECORD_REPAIR, listFailureText } from "./failure-text";

export const dynamic = "force-dynamic";

const TABS: readonly { status: AccessStatus; label: string; empty: string }[] =
  [
    {
      status: "pending",
      label: "Waiting",
      empty: "No request waiting for a decision.",
    },
    { status: "approved", label: "Approved", empty: "No approved request." },
    {
      status: "declined",
      label: "Declined",
      empty: `No request declined in the last ${DECLINED_KEPT_DAYS} days. ` +
        `Declined requests are deleted ${DECLINED_KEPT}.`,
    },
    { status: "revoked", label: "Revoked", empty: "No revoked access." },
  ];

const ONLY_UNREADABLE = "No other request on this tab.";

function QueueFullNotice({ waiting }: { waiting: number }) {
  if (waiting < MAX_PENDING) return null;
  return (
    <WarnPanel className="mb-4">
      <p>
        The queue is full: {plural(waiting, "request")} waiting, so the site
        refuses new ones. Approve or decline some to open it again.
      </p>
    </WarnPanel>
  );
}

function UnreadableNotice({ ids }: { ids: string[] }) {
  if (ids.length === 0) return null;
  return (
    <WarnPanel className="mb-4">
      <p>
        Unreadable on this tab: {plural(ids.length, "request")}. They are not
        shown and cannot be acted on from here. The site&apos;s Vercel logs
        name the problem. For each one, {RECORD_REPAIR}
      </p>
      <ul className="mono mt-1">
        {ids.map((id) => <li key={id}>{id}</li>)}
      </ul>
    </WarnPanel>
  );
}

type Tab = (typeof TABS)[number];

type Listing = Extract<Listed, { ok: true }>;

function TabNav({ counts, tab, here }: {
  counts: Listing["counts"] | null;
  tab: Tab;
  here: (status: AccessStatus) => string;
}) {
  return (
    <nav className="mb-4 flex flex-wrap gap-1 text-[13px]"
      aria-label="Requests by status">
      {TABS.map((t) => (
        <Link key={t.status} href={here(t.status)} className="nav"
          aria-current={t === tab ? "page" : undefined}>
          {t.label}
          {counts ? (
            <>
              {" "}
              <span className="mono">{counts[t.status]}</span>
            </>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}

function ListSummary({ listed, tab }: { listed: Listing; tab: Tab }) {
  return (
    <>
      {listed.counts[tab.status] >
        listed.requests.length + listed.unreadable.length ? (
        <p className="mb-3 text-xs" style={MUTED}>
          Showing the newest {listed.requests.length} of{" "}
          {listed.counts[tab.status]}. Older requests are not listed and
          cannot be changed here; a developer has to change them in Redis.
        </p>
      ) : null}
      <QueueFullNotice waiting={listed.counts.pending} />
      <UnreadableNotice ids={listed.unreadable} />
    </>
  );
}

function ListFailure({ failure, retry }: {
  failure: SiteFailure;
  retry: string;
}) {
  return (
    <WarnPanel>
      <p>{listFailureText(failure)}</p>
      <Link href={retry} className="mt-2 inline-block underline">
        Try again
      </Link>
    </WarnPanel>
  );
}

export default async function ApiAccessPage({
  searchParams,
}: {
  searchParams: Promise<{ refresh?: string; w?: string; tab?: string }>;
}) {
  const [snap, sp] = await Promise.all([readSnapshot(), searchParams]);
  const w = parseWindow(sp.w);
  const tab = TABS.find((t) => t.status === sp.tab) ?? TABS[0];
  const listed = await accessClient().listAccessRequests(tab.status);
  const here = (status: AccessStatus) =>
    withWindow(`/api-access?tab=${status}`, w);
  return (
    <Shell current="/api-access" snapshot={snap} refreshFlag={sp.refresh}
      window={w}>
      <h1 className="mb-3 text-lg font-semibold">API access</h1>
      <TabNav counts={listed.ok ? listed.counts : null} tab={tab}
        here={here} />
      {listed.ok ? <ListSummary listed={listed} tab={tab} /> : null}
      <AccessBoard
        key={tab.status}
        rows={listed.ok ? listed.requests : []}
        status={tab.status}
        emptyText={listed.ok && listed.unreadable.length > 0
          ? ONLY_UNREADABLE : tab.empty}
        failure={listed.ok ? null : (
          <ListFailure failure={listed.error} retry={here(tab.status)} />
        )} />
    </Shell>
  );
}
