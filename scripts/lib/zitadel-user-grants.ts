export type ZitadelCall = (
  path: string,
  token: string,
  options?: { method?: string; body?: unknown },
) => Promise<unknown>;

interface UserGrant {
  id: string;
  userId: string;
  projectId: string;
  roleKeys: string[];
}

export interface EnsureUserProjectRolesResult {
  action: "created" | "updated" | "unchanged";
  roleKeys: string[];
}

function isConflict(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return message.includes("409") || message.includes("already exist");
}

/**
 * Create a user's project grant or merge missing roles into its existing grant.
 *
 * ZITADEL permits only one grant per user/project. Its v1 Management API returns
 * 409 when that grant already exists, so bootstrap must search for the grant and
 * update the complete role-key set rather than treating the conflict as success.
 */
export async function ensureUserProjectRoles(
  call: ZitadelCall,
  token: string,
  userId: string,
  projectId: string,
  requestedRoleKeys: string[],
): Promise<EnsureUserProjectRolesResult> {
  const uniqueRequestedRoleKeys = [...new Set(requestedRoleKeys)];

  try {
    await call(`/management/v1/users/${userId}/grants`, token, {
      method: "POST",
      body: { projectId, roleKeys: uniqueRequestedRoleKeys },
    });
    return { action: "created", roleKeys: uniqueRequestedRoleKeys };
  } catch (error) {
    if (!isConflict(error)) throw error;
  }

  const search = (await call("/management/v1/users/grants/_search", token, {
    method: "POST",
    body: {
      queries: [{ userIdQuery: { userId } }, { projectIdQuery: { projectId } }],
    },
  })) as { result?: UserGrant[] };
  const existingGrant = search.result?.find(
    (grant) => grant.userId === userId && grant.projectId === projectId,
  );
  if (!existingGrant) {
    throw new Error(
      `Zitadel returned a grant conflict for user ${userId} and project ${projectId}, but the existing grant could not be found`,
    );
  }

  const mergedRoleKeys = [
    ...new Set([...existingGrant.roleKeys, ...uniqueRequestedRoleKeys]),
  ];
  if (mergedRoleKeys.length === existingGrant.roleKeys.length) {
    return { action: "unchanged", roleKeys: mergedRoleKeys };
  }

  await call(
    `/management/v1/users/${userId}/grants/${existingGrant.id}`,
    token,
    {
      method: "PUT",
      body: { roleKeys: mergedRoleKeys },
    },
  );
  return { action: "updated", roleKeys: mergedRoleKeys };
}
