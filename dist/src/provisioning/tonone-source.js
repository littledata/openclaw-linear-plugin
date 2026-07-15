/**
 * tonone-source.ts — fetch the tonone agent stack from its git repo at setup.
 *
 * The plugin does NOT vendor a stale snapshot: it fetches the up-to-date skills
 * from github.com/tonone-ai/tonone (configurable) at a pinned/refreshable ref
 * during the explicit provision step. Model-agnostic — nothing depends on a
 * local Claude Code install. A blobless clone keeps it fast; the checkout is
 * reused and reset on re-provision.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
/** Default upstream repo + ref for the tonone agent stack. */
export const DEFAULT_TONONE_REPO = "https://github.com/tonone-ai/tonone.git";
export const DEFAULT_TONONE_REF = "main";
/** Default cache dir: `~/.openclaw/tonone-cache`. */
export function defaultTononeCacheDir() {
    return join(homedir(), ".openclaw", "tonone-cache");
}
function git(args, cwd) {
    return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        timeout: 120_000,
        stdio: ["ignore", "pipe", "pipe"],
    }).trim();
}
/**
 * Fetch (clone or update) the tonone repo at a ref and return its local path +
 * resolved SHA. Idempotent: an existing checkout is fetched and hard-reset to
 * the requested ref rather than re-cloned.
 * @param options - repo/ref/cacheDir + optional logger
 * @returns the local checkout dir, resolved SHA, and requested ref
 */
export function fetchTononeSource(options = {}) {
    const repo = options.repo || DEFAULT_TONONE_REPO;
    const ref = options.ref || DEFAULT_TONONE_REF;
    const cacheDir = options.cacheDir || defaultTononeCacheDir();
    const dir = join(cacheDir, "tonone");
    const log = options.logger;
    mkdirSync(cacheDir, { recursive: true });
    if (!existsSync(join(dir, ".git"))) {
        log?.info(`[provision] cloning ${repo} → ${dir}`);
        // Blobless clone: full history/trees, blobs on demand — fast, allows any ref.
        git(["clone", "--filter=blob:none", "--no-checkout", repo, dir]);
    }
    else {
        log?.info(`[provision] updating existing tonone checkout at ${dir}`);
    }
    // Fetch the requested ref explicitly, then hard-checkout it. Works for a
    // branch, tag, or full SHA.
    git(["-C", dir, "fetch", "--filter=blob:none", "origin", ref]);
    git(["-C", dir, "checkout", "--force", "FETCH_HEAD"]);
    const sha = git(["-C", dir, "rev-parse", "HEAD"]);
    log?.info(`[provision] tonone source at ${ref} (${sha.slice(0, 8)})`);
    return { dir, sha, ref };
}
