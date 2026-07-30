// The ready-made skills Cloud9 ships with (his item 7, 2026-07-30 morning).
//
// Two promises are tested here, and they are the whole point of the feature:
//  1. a skill taken from the library is an ORDINARY skill — indistinguishable
//     from one he typed himself, and editable in every field;
//  2. the library is ONE table. Categories and role advice are columns in it,
//     never code, so it can grow without anything else being touched.
import test from "node:test";
import assert from "node:assert/strict";
import {
  SKILL_CATEGORIES, SKILL_LIBRARY, SKILL_LIMITS, skillFromLibrary,
  librarySkillsFor, libraryCategory,
  validateSkills, type LibrarySkill,
} from "@cloud9/shared";

test("every shipped skill fits the rules an owner-written skill has to fit", () => {
  assert.ok(SKILL_LIBRARY.length >= 12, "a library this thin is not a library");
  for (const s of SKILL_LIBRARY) {
    const asSkill = skillFromLibrary(s);
    assert.equal(validateSkills([asSkill]), null, `${s.id} would be refused: ${s.name}`);
    assert.ok(s.instructions.length > 600,
      `${s.id} has filler instructions (${s.instructions.length} characters)`);
    assert.ok(s.instructions.length <= SKILL_LIMITS.instructions);
    assert.ok(s.description.length <= SKILL_LIMITS.description);
    assert.ok(s.name.length <= SKILL_LIMITS.name);
  }
});

test("ids and names are unique, so hiring twice is never ambiguous", () => {
  assert.equal(new Set(SKILL_LIBRARY.map(s => s.id)).size, SKILL_LIBRARY.length);
  assert.equal(new Set(SKILL_LIBRARY.map(s => s.name)).size, SKILL_LIBRARY.length);
  assert.equal(new Set(SKILL_CATEGORIES.map(c => c.id)).size, SKILL_CATEGORIES.length);
});

test("every skill sits in a real category, and every category has skills in it", () => {
  const known = new Set(SKILL_CATEGORIES.map(c => c.id));
  for (const s of SKILL_LIBRARY) {
    assert.ok(known.has(s.category), `${s.id} is filed under a category that isn't there`);
    assert.equal(libraryCategory(s.category)?.id, s.category);
  }
  for (const c of SKILL_CATEGORIES) {
    assert.ok(SKILL_LIBRARY.some(s => s.category === c.id), `${c.id} is an empty shelf`);
  }
});

test("taking a skill from the library produces an ordinary, fully editable skill", () => {
  const source = SKILL_LIBRARY[0];
  const a = skillFromLibrary(source);
  const b = skillFromLibrary(source);
  assert.notEqual(a.id, b.id, "two copies are two skills, not one shared thing");
  assert.equal(a.name, source.name);
  assert.equal(a.instructions, source.instructions);
  // nothing is left pointing back at the library: once taken, it is his
  assert.deepEqual(Object.keys(a).sort(), ["description", "id", "instructions", "name"]);
  // and editing the copy cannot reach back into the shelf
  a.instructions = "changed";
  assert.notEqual(SKILL_LIBRARY[0].instructions, "changed");
});

test("an Architect and a QA engineer are not offered the same first three", () => {
  const architect = librarySkillsFor("sw-architect");
  const qa = librarySkillsFor("sw-qa");
  assert.equal(architect.length, SKILL_LIBRARY.length, "every skill is still reachable");
  assert.equal(qa.length, SKILL_LIBRARY.length);
  const firstThree = (list: LibrarySkill[]): string[] => list.slice(0, 3).map(s => s.id);
  assert.notDeepEqual(firstThree(architect), firstThree(qa));
  // the top of each list is genuinely recommended for that role, not just sorted
  for (const role of ["sw-architect", "sw-qa", "sw-security", "sw-writer"]) {
    const top = librarySkillsFor(role)[0];
    assert.ok(top.recommendedFor.includes(role), `${role} is led by a skill not meant for it`);
  }
});

test("a role nobody wrote advice for still gets the whole library, in a sane order", () => {
  const all = librarySkillsFor("sw-nobody-has-heard-of-this");
  assert.equal(all.length, SKILL_LIBRARY.length);
  assert.deepEqual(all.map(s => s.id), SKILL_LIBRARY.map(s => s.id));
});

test("every role in the hiring hall has something recommended to it", () => {
  const roles = ["sw-architect", "sw-backend", "sw-frontend", "sw-qa",
    "sw-security", "sw-devops", "sw-reviewer", "sw-writer"];
  for (const role of roles) {
    const recommended = SKILL_LIBRARY.filter(s => s.recommendedFor.includes(role));
    assert.ok(recommended.length >= 3,
      `${role} is only recommended ${recommended.length} skills`);
  }
});

test("the instructions are steps, not a description of steps", () => {
  for (const s of SKILL_LIBRARY) {
    const lines = s.instructions.split("\n");
    const steps = lines.filter(l => /^\s*(\d+\.|[-*])\s+\S/.test(l));
    assert.ok(steps.length >= 5, `${s.id} reads like prose, not a procedure`);
    assert.ok(/STOP|never|Never|do not|Do not|refuse|Refuse/.test(s.instructions),
      `${s.id} says what to do but never what not to do`);
  }
});
