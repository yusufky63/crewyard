import { describe, expect, it } from "vitest";
import { findProject, samePath } from "./folderMatch.ts";

const projects = [
  { id: "p1", name: "api", path: "C:\\Projeler\\api", lastOpenedAt: null },
  { id: "p2", name: "My App", path: "C:\\Projeler\\My App", lastOpenedAt: null },
];

describe("samePath", () => {
  it("ignores case, separators and a trailing separator", () => {
    expect(samePath("C:\\Projeler\\My App", "c:/projeler/my app/")).toBe(true);
    expect(samePath("C:\\Projeler\\api", "C:\\Projeler\\api2")).toBe(false);
  });
});

describe("findProject", () => {
  it("finds a known project however the path is spelled", () => {
    expect(findProject(projects, "c:\\projeler\\MY APP\\")?.id).toBe("p2");
  });

  it("returns null for a new folder, a parent or a subfolder of a project", () => {
    expect(findProject(projects, "C:\\Projeler\\new")).toBeNull();
    expect(findProject(projects, "C:\\Projeler")).toBeNull();
    expect(findProject(projects, "C:\\Projeler\\api\\src")).toBeNull();
  });
});
