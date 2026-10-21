import type { RedisBytes } from "../../shared/redis";

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * `base64` is set exactly when the bytes are not valid UTF-8. `text` is then a
 * display label only: printable ASCII stays, everything else becomes `\xNN`,
 * and the backslash is escaped so the label is unambiguous.
 */
export function toRedisBytes(buf: Buffer | Uint8Array): RedisBytes {
	try {
		return { text: strictUtf8.decode(buf) };
	} catch {
		let text = "";
		for (const b of buf) {
			if (b === 0x5c) text += "\\\\";
			else if (b >= 0x20 && b < 0x7f) text += String.fromCharCode(b);
			else text += `\\x${b.toString(16).padStart(2, "0")}`;
		}
		return { text, base64: Buffer.from(buf).toString("base64") };
	}
}

/** Base64 wins when present: `text` is then only a label. */
export function fromRedisBytes(bytes: RedisBytes): Buffer {
	return bytes.base64 !== undefined
		? Buffer.from(bytes.base64, "base64")
		: Buffer.from(bytes.text, "utf8");
}
