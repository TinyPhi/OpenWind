import { useTranslation } from "react-i18next";
import React from "react";
import { Dialog, DialogContent, DialogTitle, Button } from "@platform/ui";
import { fetchWithAuth, API_URL } from "../../lib/api.js";
import { showAlert } from "../../components/global-alert-dialog.js";
import { OrgBrandMark } from "../../components/org-brand-mark.js";
import {
  LOGO_ACCEPT,
  checkLogoFile,
  readLogoFile,
} from "../../lib/logo-file.js";

const MAX_NAME = 100;

export interface EditBrandingDialogProps {
  open: boolean;
  tenantId: string;
  tenantName: string;
  logo: string | null;
  onClose: () => void;
  /** Called after the new name and logo are saved. */
  onSaved: () => void;
}

/**
 * R12 (docs/specs/multi-org-sandbox.md): edit the name and logo a sandbox's users see in their
 * app header. Only what changed is sent. The preview is the same mark the header draws, so the
 * admin sees the initials fallback before saving. The file limits are checked here first so the
 * reason shows next to the picker; the server checks them again.
 */
export function EditBrandingDialog({
  open,
  tenantId,
  tenantName,
  logo,
  onClose,
  onSaved,
}: EditBrandingDialogProps): React.ReactElement {
  const { t } = useTranslation();
  const [name, setName] = React.useState(tenantName);
  // undefined = logo untouched, null = remove it, string = the newly picked image.
  const [logoDraft, setLogoDraft] = React.useState<string | null | undefined>(
    undefined,
  );
  const [fileError, setFileError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const trimmed = name.trim();
  const nameValid = trimmed.length >= 1 && trimmed.length <= MAX_NAME;
  const nameChanged = trimmed !== tenantName;
  const logoChanged = logoDraft !== undefined && logoDraft !== logo;
  const shownLogo = logoDraft === undefined ? logo : logoDraft;
  const canSave = nameValid && (nameChanged || logoChanged) && !saving;

  async function handleFile(
    e: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const problem = checkLogoFile(file);
    setFileError(problem);
    if (problem) return;
    try {
      setLogoDraft(await readLogoFile(file));
    } catch (err) {
      setFileError(
        err instanceof Error
          ? err.message
          : t("platformAdmin.couldNotReadImage"),
      );
    }
  }

  async function handleSave(): Promise<void> {
    if (!canSave) return;
    const body: { name?: string; logo?: string | null } = {};
    if (nameChanged) body.name = trimmed;
    if (logoChanged) body.logo = logoDraft ?? null;
    setSaving(true);
    try {
      await fetchWithAuth(
        `${API_URL}/platform-admin/sandboxes/${tenantId}/branding`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      onSaved();
    } catch (err) {
      showAlert(
        err instanceof Error
          ? err.message
          : t("platformAdmin.failedToSaveBranding"),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !saving) onClose();
      }}
    >
      <DialogContent style={{ maxWidth: 460 }}>
        <DialogTitle asChild>
          <h2 style={{ margin: 0, fontSize: 18 }}>
            {t("platformAdmin.editBranding")}
          </h2>
        </DialogTitle>
        <p style={{ color: "var(--text-secondary)", margin: "8px 0 16px" }}>
          Shown to this sandbox&apos;s users at the top left of the app, in
          place of the OpenWind logo.
        </p>

        <div
          aria-label="Header preview"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 14px",
            border: "1px solid var(--border-color)",
            borderRadius: "var(--radius-md)",
            marginBottom: 16,
          }}
        >
          <OrgBrandMark
            name={trimmed || tenantName}
            logo={shownLogo}
            size={28}
          />
          <span className="logo-text">{trimmed || tenantName}</span>
        </div>

        <label className="form-label" htmlFor="pa-brand-name">
          Name
        </label>
        <input
          id="pa-brand-name"
          className="form-input"
          type="text"
          maxLength={MAX_NAME}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {!nameValid && (
          <p
            style={{ color: "var(--danger)", fontSize: 13, margin: "6px 0 0" }}
          >
            Enter a name of 1 to {MAX_NAME} characters.
          </p>
        )}

        <label
          className="form-label"
          htmlFor="pa-brand-logo"
          style={{ marginTop: 14, display: "block" }}
        >
          Logo
        </label>
        <input
          id="pa-brand-logo"
          className="form-input"
          type="file"
          accept={LOGO_ACCEPT}
          onChange={(e) => void handleFile(e)}
        />
        <p className="pa-muted" style={{ marginTop: 6 }}>
          PNG, JPEG or WebP, up to 100 KB. Without one, the initials of the name
          are shown.
        </p>
        {fileError && (
          <p
            role="alert"
            style={{ color: "var(--danger)", fontSize: 13, margin: "6px 0 0" }}
          >
            {fileError}
          </p>
        )}
        {shownLogo && (
          <Button
            variant="secondary"
            onClick={() => {
              setFileError(null);
              setLogoDraft(logo === null ? undefined : null);
            }}
            disabled={saving}
          >
            Remove logo
          </Button>
        )}
        {logoDraft === null && logo !== null && (
          <Button
            variant="secondary"
            onClick={() => setLogoDraft(undefined)}
            disabled={saving}
          >
            Keep current logo
          </Button>
        )}

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 20,
          }}
        >
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleSave()}
            disabled={!canSave}
          >
            {saving ? t("platformAdmin.saving") : t("platformAdmin.save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
