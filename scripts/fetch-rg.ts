/**
 * Stages the ripgrep binary that Find in Files spawns, at `vendor/rg/rg`,
 * where `electrobun.config.ts` copies it into the app bundle.
 *
 * Official release assets, pinned and checked against their published
 * sha256, rather than `@vscode/ripgrep`: that package is a postinstall
 * downloader of the same files, and hutch never runs lifecycle scripts.
 *
 * Only the build machine's own platform is fetched, because `build.copy` has
 * no per-platform variant: a build is always for the machine it runs on.
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VERSION = "15.2.0";

const TARGETS: Record<string, string> = {
	"darwin-arm64": "aarch64-apple-darwin",
	"darwin-x64": "x86_64-apple-darwin",
	"linux-x64": "x86_64-unknown-linux-musl",
	"linux-arm64": "aarch64-unknown-linux-gnu",
};

const VENDOR_DIR = join(import.meta.dir, "..", "vendor", "rg");
const BINARY = join(VENDOR_DIR, "rg");
const STAMP = join(VENDOR_DIR, "VERSION");

async function main(): Promise<void> {
	const stamp = Bun.file(STAMP);
	if ((await Bun.file(BINARY).exists()) && (await stamp.exists())) {
		if ((await stamp.text()).trim() === VERSION) return;
	}

	const key = `${process.platform}-${process.arch}`;
	const target = TARGETS[key];
	if (!target) throw new Error(`fetch-rg: no ripgrep build for ${key}`);

	const base = `ripgrep-${VERSION}-${target}`;
	const url = `https://github.com/BurntSushi/ripgrep/releases/download/${VERSION}/${base}.tar.gz`;
	console.log(`fetch-rg: downloading ${url}`);

	const [archive, checksum] = await Promise.all([
		download(url).then((response) => response.arrayBuffer()),
		download(`${url}.sha256`).then((response) => response.text()),
	]);
	const expected = checksum.trim().split(/\s+/)[0]?.toLowerCase();
	const actual = createHash("sha256").update(new Uint8Array(archive)).digest("hex");
	if (actual !== expected) {
		throw new Error(`fetch-rg: sha256 mismatch (expected ${expected}, got ${actual})`);
	}

	const work = await mkdtemp(join(tmpdir(), "recall-rg-"));
	try {
		const tarball = join(work, `${base}.tar.gz`);
		await Bun.write(tarball, archive);
		const tar = Bun.spawn(["tar", "-xzf", tarball, "-C", work, `${base}/rg`], {
			stderr: "inherit",
		});
		if ((await tar.exited) !== 0) throw new Error("fetch-rg: tar failed");

		await mkdir(VENDOR_DIR, { recursive: true });
		await rename(join(work, base, "rg"), BINARY);
		await chmod(BINARY, 0o755);
		await Bun.write(STAMP, `${VERSION}\n`);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
	console.log(`fetch-rg: ripgrep ${VERSION} staged at ${BINARY}`);
}

async function download(url: string): Promise<Response> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`fetch-rg: ${url} → HTTP ${response.status}`);
	return response;
}

await main();
