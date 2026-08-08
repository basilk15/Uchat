import { describe, expect, it } from 'vitest';
import { DEFAULT_DISCOVERY_PORT, DEFAULT_TCP_PORT } from '@shared/defaults';
import { MAX_PORT, MIN_PORT } from '@shared/validation';
import {
  DEFAULT_PORT_DRAFT,
  PORT_RANGE_HELPER,
  validatePortDraft,
  validatePortDrafts
} from './portSettings';

describe('renderer port settings', () => {
  it('starts with the shared runtime defaults and range guidance', () => {
    expect(DEFAULT_PORT_DRAFT).toEqual({
      udpPort: String(DEFAULT_DISCOVERY_PORT),
      tcpPort: String(DEFAULT_TCP_PORT)
    });
    expect(PORT_RANGE_HELPER).toContain(MIN_PORT.toLocaleString());
    expect(PORT_RANGE_HELPER).toContain(MAX_PORT.toLocaleString());
  });

  it('normalizes valid drafts into the existing join input port values', () => {
    expect(validatePortDrafts({ udpPort: '49001', tcpPort: '49002' })).toEqual({
      errors: {},
      values: {
        udpPort: 49001,
        tcpPort: 49002
      }
    });
  });

  it('reports empty, fractional, and out-of-range drafts without changing them', () => {
    expect(validatePortDraft('', 'udpPort')).toEqual({ error: 'UDP discovery port is required.' });
    expect(validatePortDraft('47475.5', 'udpPort').error).toContain('whole number');
    expect(validatePortDraft(String(MAX_PORT + 1), 'tcpPort').error).toContain(MAX_PORT.toLocaleString());

    expect(validatePortDrafts({ udpPort: '49001.5', tcpPort: '49002' })).toEqual({
      errors: {
        udpPort: expect.stringContaining('whole number')
      }
    });
  });
});
