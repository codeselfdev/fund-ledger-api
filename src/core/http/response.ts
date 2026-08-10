import type { Response } from "express";

export function ok(res: Response, data: unknown = {}, meta?: unknown) {
  return res.json({ ok: true, data, ...(meta ? { meta } : {}) });
}

export function created(res: Response, data: unknown = {}, meta?: unknown) {
  return res.status(201).json({ ok: true, data, ...(meta ? { meta } : {}) });
}

export function empty(res: Response) {
  return res.status(204).send();
}
