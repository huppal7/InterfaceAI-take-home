/**
 * Artifact store — save/load capability artifacts as versioned JSON files.
 *
 * Layout: artifacts/<id>@<version>.json   (id may contain dots, e.g. member.read_balance)
 * A simple, reviewable, diff-friendly on-disk format. In production this would be a
 * catalog service, but the shape (id + version + JSON body) is the same.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArtifact, type CapabilityArtifact } from "../types/artifact.js";

const DIR = process.env.ARTIFACT_DIR ?? "artifacts";

function ensureDir() {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
}

export function fileName(id: string, version: string): string {
  return `${id}@${version}.json`;
}

export function saveArtifact(a: CapabilityArtifact): string {
  ensureDir();
  const path = join(DIR, fileName(a.id, a.version));
  writeFileSync(path, JSON.stringify(a, null, 2));
  return path;
}

export function loadArtifactFromPath(path: string): CapabilityArtifact {
  return parseArtifact(JSON.parse(readFileSync(path, "utf8")));
}

export function loadArtifact(id: string, version?: string): CapabilityArtifact {
  ensureDir();
  if (version) return loadArtifactFromPath(join(DIR, fileName(id, version)));
  // latest version by lexical sort of matching files
  const matches = readdirSync(DIR)
    .filter((f) => f.startsWith(`${id}@`) && f.endsWith(".json"))
    .sort();
  if (matches.length === 0) throw new Error(`no artifact found for id "${id}" in ${DIR}`);
  return loadArtifactFromPath(join(DIR, matches[matches.length - 1]));
}

export function listArtifacts(): CapabilityArtifact[] {
  ensureDir();
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return loadArtifactFromPath(join(DIR, f));
      } catch {
        return undefined;
      }
    })
    .filter((a): a is CapabilityArtifact => !!a);
}
