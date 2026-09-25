import { ReceiptsError, type SurfaceDef } from "./types.js";

const registry = new Map<string, SurfaceDef>();

export function registerSurface(surface: SurfaceDef): void {
  if (!surface || typeof surface.name !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(surface.name)) {
    throw new ReceiptsError("invalid_surface", "A surface needs a lowercase hyphenated name.");
  }
  if (!(surface.idPattern instanceof RegExp) || (surface.observe !== undefined && typeof surface.observe !== "function")) {
    throw new ReceiptsError("invalid_surface", "A surface needs an ID pattern and an optional observation function.");
  }
  if (registry.has(surface.name)) {
    throw new ReceiptsError("surface_already_registered", `Surface ${surface.name} is already registered.`);
  }
  registry.set(surface.name, Object.freeze({
    name: surface.name,
    idPattern: new RegExp(surface.idPattern.source, surface.idPattern.flags.replace(/[gy]/g, "")),
    ...(surface.observe ? { observe: surface.observe } : {}),
  }));
}

export function getSurface(name: string): SurfaceDef {
  const surface = registry.get(name);
  if (!surface) throw new ReceiptsError("not_a_destination_write", `Unknown outward-write surface: ${String(name)}.`);
  return { ...surface, idPattern: new RegExp(surface.idPattern.source, surface.idPattern.flags) };
}

export function listSurfaces(): readonly string[] {
  return Object.freeze([...registry.keys()]);
}

/** Generic examples validate shape, not ownership or authenticity. */
registerSurface({ name: "http-post", idPattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/ });
registerSurface({ name: "social-publish", idPattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/ });
registerSurface({ name: "email-send", idPattern: /^[A-Za-z0-9<][A-Za-z0-9._:@<>+-]{0,255}$/ });
registerSurface({ name: "file-write", idPattern: /^file:\/[^\u0000\r\n]+$/ });
