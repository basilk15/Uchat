import { DEFAULT_DISCOVERY_PORT, DEFAULT_TCP_PORT } from '@shared/defaults';
import { MAX_PORT, MIN_PORT, normalizePort, ValidationError } from '@shared/validation';

export type PortField = 'udpPort' | 'tcpPort';

export interface PortDraft {
  udpPort: string;
  tcpPort: string;
}

export interface PortValues {
  udpPort: number;
  tcpPort: number;
}

export type PortDraftErrors = Partial<Record<PortField, string>>;

export const DEFAULT_PORT_DRAFT: PortDraft = {
  udpPort: String(DEFAULT_DISCOVERY_PORT),
  tcpPort: String(DEFAULT_TCP_PORT)
};

export const PORT_FIELD_LABELS: Record<PortField, string> = {
  udpPort: 'UDP discovery port',
  tcpPort: 'TCP chat port'
};

export const PORT_RANGE_HELPER = `Whole numbers from ${MIN_PORT.toLocaleString()} to ${MAX_PORT.toLocaleString()}.`;

export interface PortDraftValidation {
  value?: number;
  error?: string;
}

export const validatePortDraft = (value: string, field: PortField): PortDraftValidation => {
  if (value.trim().length === 0) {
    return { error: `${PORT_FIELD_LABELS[field]} is required.` };
  }

  try {
    return { value: normalizePort(Number(value), field) };
  } catch (error) {
    if (!(error instanceof ValidationError)) {
      throw error;
    }

    return {
      error: `${PORT_FIELD_LABELS[field]} must be a whole number from ${MIN_PORT.toLocaleString()} to ${MAX_PORT.toLocaleString()}.`
    };
  }
};

export interface PortDraftValidationResult {
  errors: PortDraftErrors;
  values?: PortValues;
}

export const validatePortDrafts = (draft: PortDraft): PortDraftValidationResult => {
  const udp = validatePortDraft(draft.udpPort, 'udpPort');
  const tcp = validatePortDraft(draft.tcpPort, 'tcpPort');
  const errors: PortDraftErrors = {};

  if (udp.error) {
    errors.udpPort = udp.error;
  }

  if (tcp.error) {
    errors.tcpPort = tcp.error;
  }

  return {
    errors,
    ...(udp.value === undefined || tcp.value === undefined
      ? {}
      : { values: { udpPort: udp.value, tcpPort: tcp.value } })
  };
};
