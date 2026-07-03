// In-memory token bucket rate-limiter, per-user.
//
// Lives in the Node.js module scope of one Railway instance. With a single
// instance (which is what we run), this is correct. If we ever scale
// horizontally, switch to Redis-backed.
//
// Defaults: 20 reads / min / user, 20 destructive actions / hour / user.

type Bucket = { tokens: number; lastRefill: number };

const READ_CAP = 20;
const READ_PER_MIN = 20;
const DESTRUCTIVE_CAP = 20;
const DESTRUCTIVE_PER_HOUR = 20;

const readBuckets = new Map<string, Bucket>();
const destructiveBuckets = new Map<string, Bucket>();

function take(map: Map<string, Bucket>, key: string, cap: number, refillPerSec: number): boolean {
	const now = Date.now() / 1000;
	let b = map.get(key);
	if (!b) {
		b = { tokens: cap, lastRefill: now };
		map.set(key, b);
	}
	const elapsed = now - b.lastRefill;
	b.tokens = Math.min(cap, b.tokens + elapsed * refillPerSec);
	b.lastRefill = now;
	if (b.tokens >= 1) {
		b.tokens -= 1;
		return true;
	}
	return false;
}

export function allowRead(user: string): boolean {
	return take(readBuckets, user, READ_CAP, READ_PER_MIN / 60);
}

export function allowDestructive(user: string): boolean {
	return take(destructiveBuckets, user, DESTRUCTIVE_CAP, DESTRUCTIVE_PER_HOUR / 3600);
}
