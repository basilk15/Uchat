import type { MessageDeliveryState } from './types';

export const MESSAGE_DELIVERY_STATES: readonly MessageDeliveryState[] = [
  'sending',
  'sent',
  'delivered',
  'failed',
  'unsent'
] as const;

const DELIVERY_TRANSITIONS: Record<MessageDeliveryState, readonly MessageDeliveryState[]> = {
  sending: ['sent', 'failed', 'unsent'],
  sent: ['delivered', 'failed'],
  delivered: [],
  failed: ['sending', 'unsent'],
  unsent: ['sending', 'failed']
};

export const isMessageDeliveryState = (value: string): value is MessageDeliveryState =>
  MESSAGE_DELIVERY_STATES.includes(value as MessageDeliveryState);

export const canTransitionDeliveryState = (
  from: MessageDeliveryState,
  to: MessageDeliveryState
): boolean => from === to || DELIVERY_TRANSITIONS[from].includes(to);
