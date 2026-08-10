import { nanoid } from "nanoid";
import type { Prisma } from "@prisma/client";

type DepositDelegatePermission = {
  id: string;
  project_id: string;
  user_id: string;
  is_active: boolean;
  created_by_id: string | null;
  created_at: string;
  updated_at: string;
};

const KEY = "member_deposit_delegate_permissions";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function parsePermissions(contact: unknown): DepositDelegatePermission[] {
  if (!isRecord(contact)) return [];
  const raw = contact[KEY];
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .map((item) => ({
      id: typeof item.id === "string" ? item.id : nanoid(),
      project_id: typeof item.project_id === "string" ? item.project_id : "",
      user_id: typeof item.user_id === "string" ? item.user_id : "",
      is_active: item.is_active !== false,
      created_by_id: typeof item.created_by_id === "string" ? item.created_by_id : null,
      created_at: typeof item.created_at === "string" ? item.created_at : new Date().toISOString(),
      updated_at: typeof item.updated_at === "string" ? item.updated_at : new Date().toISOString()
    }))
    .filter((item) => item.project_id.length > 0 && item.user_id.length > 0);
}

function writePermissions(contact: unknown, permissions: DepositDelegatePermission[]): Prisma.InputJsonValue {
  const base = isRecord(contact) ? { ...contact } : {};
  return toJson({
    ...base,
    [KEY]: permissions
  });
}

export function listDepositDelegatePermissions(contact: unknown, projectId: string) {
  return parsePermissions(contact).filter((permission) => permission.project_id === projectId);
}

export function canUserPayOnBehalf(contact: unknown, projectId: string, userId: string) {
  return listDepositDelegatePermissions(contact, projectId).some(
    (permission) => permission.user_id === userId && permission.is_active
  );
}

export function upsertDepositDelegatePermission(input: {
  contact: unknown;
  projectId: string;
  userId: string;
  actorUserId: string;
  isActive: boolean;
}) {
  const current = parsePermissions(input.contact);
  const now = new Date().toISOString();
  const existing = current.find((permission) => (
    permission.project_id === input.projectId && permission.user_id === input.userId
  ));

  let updatedPermission: DepositDelegatePermission;
  let next: DepositDelegatePermission[];
  if (existing) {
    updatedPermission = {
      ...existing,
      is_active: input.isActive,
      updated_at: now
    };
    next = current.map((permission) => (
      permission.id === existing.id ? updatedPermission : permission
    ));
  } else {
    updatedPermission = {
      id: nanoid(),
      project_id: input.projectId,
      user_id: input.userId,
      is_active: input.isActive,
      created_by_id: input.actorUserId,
      created_at: now,
      updated_at: now
    };
    next = [...current, updatedPermission];
  }

  return {
    permission: updatedPermission,
    contact: writePermissions(input.contact, next)
  };
}
