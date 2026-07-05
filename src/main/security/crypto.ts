import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  scrypt as nodeScrypt,
  type ScryptOptions,
  type KeyObject,
  createCipheriv,
  createDecipheriv
} from 'node:crypto';

const scrypt = (password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    nodeScrypt(password, salt, keylen, options, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(derivedKey);
    });
  });

export const ROOM_KEY_BYTES = 32;
export const SESSION_KEY_BYTES = 32;
export const AES_256_GCM_IV_BYTES = 12;
export const AES_256_GCM_TAG_BYTES = 16;
export const ROOM_FINGERPRINT_BYTES = 16;

export const ROOM_KEY_SCRYPT_PARAMS = {
  cost: 32768,
  blockSize: 8,
  parallelization: 1,
  maxmem: 64 * 1024 * 1024
} as const;

export interface DerivedRoomKey {
  roomName: string;
  key: Buffer;
  fingerprint: string;
}

export interface X25519Identity {
  publicKey: string;
  privateKey: string;
}

export interface EncryptedFrame {
  algorithm: 'aes-256-gcm';
  iv: string;
  ciphertext: string;
  authTag: string;
}

const normalizeRoomName = (roomName: string): string => roomName.trim().toLocaleLowerCase();

const toBase64Url = (input: Buffer): string => input.toString('base64url');

const fromBase64Url = (input: string): Buffer => Buffer.from(input, 'base64url');

const roomSaltFor = (roomName: string): Buffer =>
  createHash('sha256').update('uchat-room-salt:v1').update('\0').update(normalizeRoomName(roomName)).digest();

const assertKeyLength = (key: Buffer, expectedBytes: number, label: string): void => {
  if (key.byteLength !== expectedBytes) {
    throw new Error(`${label} must be ${expectedBytes} bytes.`);
  }
};

const exportPublicKey = (publicKey: KeyObject): string =>
  toBase64Url(publicKey.export({ format: 'der', type: 'spki' }) as Buffer);

const exportPrivateKey = (privateKey: KeyObject): string =>
  toBase64Url(privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer);

const importPublicKey = (publicKey: string): KeyObject =>
  createPublicKey({
    key: fromBase64Url(publicKey),
    format: 'der',
    type: 'spki'
  });

const importPrivateKey = (privateKey: string): KeyObject =>
  createPrivateKey({
    key: fromBase64Url(privateKey),
    format: 'der',
    type: 'pkcs8'
  });

export const createRoomFingerprint = (roomKey: Buffer, roomName: string): string => {
  assertKeyLength(roomKey, ROOM_KEY_BYTES, 'roomKey');

  const digest = createHmac('sha256', roomKey)
    .update('uchat-room-fingerprint:v1')
    .update('\0')
    .update(normalizeRoomName(roomName))
    .digest();

  return toBase64Url(digest.subarray(0, ROOM_FINGERPRINT_BYTES));
};

export const deriveRoomKey = async (roomName: string, passphrase: string): Promise<DerivedRoomKey> => {
  const normalizedRoomName = normalizeRoomName(roomName);
  const key = (await scrypt(passphrase, roomSaltFor(normalizedRoomName), ROOM_KEY_BYTES, ROOM_KEY_SCRYPT_PARAMS)) as Buffer;

  return {
    roomName: normalizedRoomName,
    key,
    fingerprint: createRoomFingerprint(key, normalizedRoomName)
  };
};

export const generateX25519Identity = (): X25519Identity => {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');

  return {
    publicKey: exportPublicKey(publicKey),
    privateKey: exportPrivateKey(privateKey)
  };
};

export const deriveX25519SharedSecret = (privateKey: string, remotePublicKey: string): Buffer =>
  diffieHellman({
    privateKey: importPrivateKey(privateKey),
    publicKey: importPublicKey(remotePublicKey)
  });

const sessionInfoFor = (localPublicKey: string, remotePublicKey: string): Buffer => {
  const orderedKeys = [localPublicKey, remotePublicKey].sort();

  return Buffer.concat([
    Buffer.from('uchat-peer-session:v1'),
    Buffer.from([0]),
    fromBase64Url(orderedKeys[0]),
    Buffer.from([0]),
    fromBase64Url(orderedKeys[1])
  ]);
};

export const derivePeerSessionKey = (input: {
  roomKey: Buffer;
  privateKey: string;
  localPublicKey: string;
  remotePublicKey: string;
}): Buffer => {
  assertKeyLength(input.roomKey, ROOM_KEY_BYTES, 'roomKey');

  const sharedSecret = deriveX25519SharedSecret(input.privateKey, input.remotePublicKey);
  const key = hkdfSync('sha256', sharedSecret, input.roomKey, sessionInfoFor(input.localPublicKey, input.remotePublicKey), SESSION_KEY_BYTES);

  return Buffer.from(key);
};

export const encryptFrame = (sessionKey: Buffer, plaintext: Buffer | string, aad?: Buffer | string): EncryptedFrame => {
  assertKeyLength(sessionKey, SESSION_KEY_BYTES, 'sessionKey');

  const iv = randomBytes(AES_256_GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', sessionKey, iv, {
    authTagLength: AES_256_GCM_TAG_BYTES
  });

  if (aad !== undefined) {
    cipher.setAAD(Buffer.isBuffer(aad) ? aad : Buffer.from(aad));
  }

  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    algorithm: 'aes-256-gcm',
    iv: toBase64Url(iv),
    ciphertext: toBase64Url(ciphertext),
    authTag: toBase64Url(authTag)
  };
};

export const decryptFrame = (sessionKey: Buffer, frame: EncryptedFrame, aad?: Buffer | string): Buffer => {
  assertKeyLength(sessionKey, SESSION_KEY_BYTES, 'sessionKey');

  if (frame.algorithm !== 'aes-256-gcm') {
    throw new Error(`Unsupported frame algorithm: ${frame.algorithm}`);
  }

  const decipher = createDecipheriv('aes-256-gcm', sessionKey, fromBase64Url(frame.iv), {
    authTagLength: AES_256_GCM_TAG_BYTES
  });

  if (aad !== undefined) {
    decipher.setAAD(Buffer.isBuffer(aad) ? aad : Buffer.from(aad));
  }

  decipher.setAuthTag(fromBase64Url(frame.authTag));

  return Buffer.concat([decipher.update(fromBase64Url(frame.ciphertext)), decipher.final()]);
};
