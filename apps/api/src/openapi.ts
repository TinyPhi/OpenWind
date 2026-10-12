/**
 * openapi.ts
 *
 * Static OpenAPI 3.1 spec object for the platform API.
 *
 * Routes are documented here alongside their Zod schema definitions.
 * The spec is served at GET /openapi.json — unauthenticated.
 *
 * Convention: paths are grouped by domain tag (files, admin, preferences,
 * entity-types, entities, workflows, automation-rules).
 */

export const openApiSpec = {
  openapi: "3.1.0",
  info: {
    title: "OpenWind Platform API",
    version: "1.0.0",
    description:
      "Modular business platform — entity engine, workflow engine, automation engine.",
  },
  servers: [{ url: "/" }],
  tags: [
    { name: "files", description: "File upload, download, and management" },
    { name: "admin", description: "Audit log and view config management" },
    {
      name: "preferences",
      description: "User notification preferences",
    },
    { name: "entity-types", description: "Entity type and field management" },
    { name: "entities", description: "Entity instance CRUD and transitions" },
    {
      name: "workflows",
      description: "Workflow definitions and state management",
    },
    {
      name: "automation-rules",
      description: "Automation rule CRUD and webhook actions",
    },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
      },
    },
    schemas: {
      Error: {
        type: "object",
        required: ["error", "message"],
        properties: {
          error: { type: "string" },
          message: { type: "string" },
          fields: {
            type: "array",
            items: {
              type: "object",
              properties: {
                field: { type: "string" },
                code: { type: "string" },
                message: { type: "string" },
              },
            },
          },
        },
      },
      FileRecord: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          tenantId: { type: "string", format: "uuid" },
          moduleSlug: { type: "string" },
          entityId: { type: "string", format: "uuid", nullable: true },
          originalName: { type: "string" },
          storageKey: { type: "string" },
          mimeType: { type: "string" },
          sizeBytes: { type: "integer" },
          scanStatus: {
            type: "string",
            enum: ["pending", "clean", "quarantined", "scan_failed", "deleted"],
          },
          uploadedBy: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      AuditEntry: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          tenantId: { type: "string", format: "uuid" },
          actorId: { type: "string" },
          actorType: { type: "string", enum: ["user", "api_key", "system"] },
          resourceType: { type: "string" },
          resourceId: { type: "string", format: "uuid" },
          action: {
            type: "string",
            enum: ["created", "updated", "deleted", "transitioned", "restored"],
          },
          beforeSnapshot: { type: "object", nullable: true },
          afterSnapshot: { type: "object", nullable: true },
          metadata: { type: "object", nullable: true },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      ViewConfig: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          tenantId: { type: "string", format: "uuid" },
          entityTypeSlug: { type: "string" },
          listColumns: { type: "array" },
          detailLayout: { type: "array" },
          formFieldOrder: { type: "array" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      NotificationPreferences: {
        type: "object",
        properties: {
          channels: {
            type: "object",
            properties: {
              email: { type: "boolean" },
              inApp: { type: "boolean" },
              sms: { type: "boolean" },
            },
          },
          templateOverrides: { type: "object" },
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    "/health": {
      get: {
        summary: "Health check",
        security: [],
        responses: {
          "200": { description: "OK", content: { "application/json": {} } },
        },
      },
    },

    // ── Files ─────────────────────────────────────────────────────────────────

    "/files": {
      post: {
        tags: ["files"],
        summary: "Initiate file upload",
        description:
          "Returns a presigned S3 PUT URL. Client uploads directly to S3, then calls POST /files/:id/complete.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: [
                  "originalName",
                  "mimeType",
                  "sizeBytes",
                  "moduleSlug",
                ],
                properties: {
                  originalName: { type: "string" },
                  mimeType: { type: "string" },
                  sizeBytes: {
                    type: "integer",
                    minimum: 1,
                    maximum: 104857600,
                  },
                  moduleSlug: { type: "string" },
                  entityId: { type: "string", format: "uuid" },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "Upload initiated" },
          "422": { description: "Quota exceeded or file too large" },
        },
      },
    },
    "/files/{id}/complete": {
      post: {
        tags: ["files"],
        summary: "Complete file upload",
        description: "Marks upload as complete and enqueues AV scan job.",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": { description: "Upload confirmed, AV scan enqueued" },
          "404": { description: "File not found" },
        },
      },
    },
    "/files/{id}": {
      get: {
        tags: ["files"],
        summary: "Get presigned download URL",
        description:
          "Returns a time-limited presigned GET URL. Blocked for pending/quarantined files.",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": { description: "Download URL" },
          "404": { description: "File not found" },
          "422": {
            description: "File not yet clean (pending scan or quarantined)",
          },
        },
      },
      delete: {
        tags: ["files"],
        summary: "Soft-delete a file",
        description:
          "Admin only. Marks deleted, releases quota, async S3 cleanup.",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "204": { description: "Deleted" },
          "404": { description: "File not found" },
        },
      },
    },

    // ── Admin ─────────────────────────────────────────────────────────────────

    "/admin/audit": {
      get: {
        tags: ["admin"],
        summary: "Query audit log",
        description:
          "Admin only. Cursor-paginated (newest-first), max 100 per page.",
        parameters: [
          { name: "actorId", in: "query", schema: { type: "string" } },
          {
            name: "actorType",
            in: "query",
            schema: { type: "string", enum: ["user", "api_key", "system"] },
          },
          { name: "resourceType", in: "query", schema: { type: "string" } },
          {
            name: "resourceId",
            in: "query",
            schema: { type: "string", format: "uuid" },
          },
          {
            name: "action",
            in: "query",
            // No enum: this spec is served unauthenticated, and the set of audit
            // action names is internal. The route validates against the real list.
            description:
              "Only entries with this audit action (for example access.revoked). An unknown value is a 400 VALIDATION_ERROR. For a per-resource query pass resourceType too.",
            schema: { type: "string" },
          },
          {
            name: "from",
            in: "query",
            schema: { type: "string", format: "date-time" },
          },
          {
            name: "to",
            in: "query",
            schema: { type: "string", format: "date-time" },
          },
          {
            name: "cursor",
            in: "query",
            schema: { type: "string", format: "date-time" },
          },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
          },
        ],
        responses: {
          "200": { description: "Audit entries" },
        },
      },
    },
    "/admin/view-configs/{entityType}": {
      get: {
        tags: ["admin"],
        summary: "Get view config for entity type",
        parameters: [
          {
            name: "entityType",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": { description: "View config" },
        },
      },
      patch: {
        tags: ["admin"],
        summary: "Upsert view config for entity type",
        description: "Admin only. Tenant-scoped upsert.",
        parameters: [
          {
            name: "entityType",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  listColumns: { type: "array" },
                  detailLayout: { type: "array" },
                  formFieldOrder: { type: "array" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Updated" },
          "201": { description: "Created" },
        },
      },
    },

    // ── Preferences ───────────────────────────────────────────────────────────

    "/preferences/notifications": {
      get: {
        tags: ["preferences"],
        summary: "Get current user's notification preferences",
        responses: {
          "200": { description: "Notification preferences" },
        },
      },
      patch: {
        tags: ["preferences"],
        summary: "Update current user's notification preferences",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  channels: {
                    type: "object",
                    properties: {
                      email: { type: "boolean" },
                      inApp: { type: "boolean" },
                      sms: { type: "boolean" },
                    },
                  },
                  templateOverrides: { type: "object" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Updated preferences" },
        },
      },
    },
  },
} as const;
