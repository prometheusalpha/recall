/**
 * Text forms of Redis values for the workspace: TTLs for the key list and the
 * value header, replies for the console. Pure, so they are tested directly.
 */
import type { RedisBytes, RedisReply } from "../../shared/redis";

/** Identity of a key or field in maps and selections: the bytes, not the label. */
export function bytesId(bytes: RedisBytes): string {
	return bytes.base64 !== undefined ? `b:${bytes.base64}` : `t:${bytes.text}`;
}

/**
 * Compact TTL: the largest two units, so `3d 4h` rather than seconds nobody
 * can read at a glance. -1 is a key that never expires; -2 one that is gone.
 */
export function formatTtl(seconds: number): string {
	if (seconds === -1) return "No expiry";
	if (seconds < 0) return "Expired";
	const units: [string, number][] = [
		["d", 86_400],
		["h", 3_600],
		["m", 60],
		["s", 1],
	];
	const parts: string[] = [];
	let rest = seconds;
	for (const [label, size] of units) {
		const count = Math.floor(rest / size);
		if (count > 0 || (label === "s" && parts.length === 0)) {
			parts.push(`${count}${label}`);
		}
		rest -= count * size;
		if (parts.length === 2) break;
	}
	return parts.join(" ");
}

function isBytes(reply: RedisReply): reply is RedisBytes {
	return reply !== null && typeof reply === "object" && "text" in reply;
}

/**
 * A reply laid out the way `redis-cli` prints it, so output reads the same as
 * in the terminal people already know: `(nil)`, `(integer) 3`, numbered and
 * indented array items. Binary bulk strings show their escaped label.
 */
export function formatReply(reply: RedisReply, indent = ""): string {
	if (reply === null) return "(nil)";
	if (typeof reply === "number") return `(integer) ${reply}`;
	if (isBytes(reply)) return JSON.stringify(reply.text);
	if (!Array.isArray(reply)) return `(error) ${reply.error}`;
	if (reply.length === 0) return "(empty array)";
	const width = String(reply.length).length;
	return reply
		.map((item, index) => {
			const label = `${String(index + 1).padStart(width)}) `;
			const nested = formatReply(item, `${indent}${" ".repeat(label.length)}`);
			return `${index === 0 ? "" : indent}${label}${nested}`;
		})
		.join("\n");
}
