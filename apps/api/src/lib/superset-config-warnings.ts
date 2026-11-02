import { supersetConfigWarnings } from "@platform/config";
import { logger } from "@platform/logger";

type SupersetWarningConfig = Parameters<typeof supersetConfigWarnings>[0];

export function logSupersetConfigWarnings(config: SupersetWarningConfig): void {
  for (const warning of supersetConfigWarnings(config))
    logger.warn({}, warning);
}
