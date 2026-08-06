import type { MessageDeliveryState } from './types';
import { MESSAGE_DELIVERY_STATES as VALIDATED_MESSAGE_DELIVERY_STATES } from './validation';

export const MESSAGE_DELIVERY_STATES: readonly MessageDeliveryState[] = VALIDATED_MESSAGE_DELIVERY_STATES;

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
