import { expect, test } from "bun:test";
import { FIELDS, type Field, fieldErrors } from "./access-request-fields";

function fieldOf(name: Field) {
  const field = FIELDS.find((f) => f.name === name);
  if (!field) throw new Error(`no field ${name}`);
  return field;
}

test("a pasted field asks to type it, the others keep their own error", () => {
  const [name, website, ...rest] = fieldErrors(["website", "name"], ["name"]);
  expect(rest).toEqual([]);
  expect(name?.field).toBe("name");
  expect(name?.text).toContain(`"${fieldOf("name").label}"`);
  expect(name?.text).not.toBe(fieldOf("name").error);
  expect(website).toEqual({ field: "website", text: fieldOf("website").error });
});
