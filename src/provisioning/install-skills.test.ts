import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseFrontmatter,
  installSkills,
  listInstalledSkills,
  readPersona,
} from "./install-skills.js";
import type { RosterAgent } from "./agent-roster.js";

describe("parseFrontmatter", () => {
  it("extracts scalar keys and strips the block", () => {
    const { frontmatter, body } = parseFrontmatter(
      "---\nname: apex-plan\ndescription: Plan a project\nversion: 0.6.4\n---\n# Body\ntext",
    );
    expect(frontmatter.name).toBe("apex-plan");
    expect(frontmatter.description).toBe("Plan a project");
    expect(frontmatter.version).toBe("0.6.4");
    expect(body).toBe("# Body\ntext");
  });

  it("returns the whole input as body when there is no frontmatter", () => {
    const { frontmatter, body } = parseFrontmatter("no frontmatter here");
    expect(frontmatter).toEqual({});
    expect(body).toBe("no frontmatter here");
  });

  it("unquotes quoted values", () => {
    expect(parseFrontmatter('---\nname: "x"\n---\nb').frontmatter.name).toBe("x");
  });
});

describe("installSkills", () => {
  let source: string;
  let dest: string;

  const roster: RosterAgent[] = [
    {
      id: "apex",
      label: "Apex",
      tononeAgent: "apex",
      skills: ["apex-plan", "missing-skill"],
      kind: "plan-implement",
      summary: "lead",
    },
  ];

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "tonone-src-"));
    source = join(root, "src");
    dest = join(root, "dest");
    // Fake tonone repo layout: team/apex/{agents,skills}
    const skillDir = join(source, "team", "apex", "skills", "apex-plan");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: apex-plan\ndescription: Plan a project\nallowed-tools: Read, Write, Task\nversion: 0.6.4\n---\n# Apex Plan\nScope the work.",
    );
    writeFileSync(join(skillDir, "helper.md"), "supporting doc");
    const agentDir = join(source, "team", "apex", "agents");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "apex.md"),
      "---\nname: apex\ndescription: Engineering lead\nmodel: opus\n---\nYou are Apex.",
    );
  });

  afterEach(() => {
    rmSync(join(source, ".."), { recursive: true, force: true });
  });

  it("installs present skills, reports missing ones, and normalizes frontmatter", () => {
    const result = installSkills(source, roster, dest);
    expect(result.installed).toEqual(["apex-plan"]);
    expect(result.missing).toEqual(["missing-skill"]);

    const installedMd = readFileSync(join(dest, "apex-plan", "SKILL.md"), "utf8");
    expect(installedMd).toContain("name: apex-plan");
    expect(installedMd).toContain("description: Plan a project");
    // Claude-Code-only frontmatter dropped
    expect(installedMd).not.toContain("allowed-tools");
    expect(installedMd).not.toContain("version:");
    // Body preserved verbatim
    expect(installedMd).toContain("Scope the work.");
    // Supporting files copied
    expect(readFileSync(join(dest, "apex-plan", "helper.md"), "utf8")).toBe("supporting doc");
  });

  it("collects the agent persona", () => {
    const result = installSkills(source, roster, dest);
    expect(result.personas.apex?.name).toBe("apex");
    expect(result.personas.apex?.body).toContain("You are Apex.");
  });

  it("listInstalledSkills reflects what was installed", () => {
    installSkills(source, roster, dest);
    expect(listInstalledSkills(dest)).toEqual(["apex-plan"]);
  });

  it("readPersona returns null when the persona file is absent", () => {
    expect(readPersona(source, "nonexistent")).toBeNull();
  });
});
