import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GroupMessage } from 'zca-js';
import {
  detectTriggerKind,
  extractReadableText,
  isMessageIdLessOrEqual,
  normalizeZaloMessage,
} from '../src/zalo/message-normalizer.js';
import { buildQuoteFromRawMessage } from '../src/services/outbox-sender.js';

const BOT_UID = '1000';

test('tag đúng bot -> mention', () => {
  const message = { mentions: [{ uid: '1000', pos: 0, len: 4, type: 0 }], text: '@Bot hi' };
  assert.equal(detectTriggerKind(message, BOT_UID), 'mention');
});

test('tag người khác -> không gọi bot', () => {
  const message = { mentions: [{ uid: '2000', pos: 0, len: 3, type: 0 }], text: '@An hi' };
  assert.equal(detectTriggerKind(message, BOT_UID), null);
});

test('reply vào tin của bot -> quote (chỉ khi bật)', () => {
  const message = { quote: { ownerId: '1000' }, text: 'thế còn giá?' };
  assert.equal(detectTriggerKind(message, BOT_UID, { replyOnQuoteToBot: true }), 'quote');
  assert.equal(detectTriggerKind(message, BOT_UID, { replyOnQuoteToBot: false }), null);
});

test('@All -> chỉ gọi bot khi bật', () => {
  const message = { mentions: [{ uid: '-1', pos: 0, len: 4, type: 1 }], text: '@All' };
  assert.equal(detectTriggerKind(message, BOT_UID), null);
  assert.equal(detectTriggerKind(message, BOT_UID, { replyOnMentionAll: true }), 'mention_all');
});

test('từ khoá kích hoạt không phân biệt hoa thường', () => {
  assert.equal(detectTriggerKind({ text: 'Hỏi /BOT giá tour' }, BOT_UID, { keywords: ['/bot'] }), 'keyword');
});

test('chuẩn hoá GroupMessage của zca-js', () => {
  const groupMessage = new GroupMessage(BOT_UID, {
    msgId: '7000000000001',
    cliMsgId: '1',
    msgType: 'webchat',
    uidFrom: '2000',
    idTo: 'g1',
    dName: 'Khách A',
    ts: '1732150000000',
    content: '@Bot giá tour?',
    mentions: [{ uid: '1000', pos: 0, len: 4, type: 0 }],
  });
  const message = normalizeZaloMessage(groupMessage, BOT_UID, 'live');
  assert.equal(message.threadType, 'group');
  assert.equal(message.threadId, 'g1');
  assert.equal(message.timestamp, 1732150000000);
  assert.equal(message.triggerKind, 'mention');
  assert.equal(message.triggersBot, true);
});

test('tin của chính bot không bao giờ kích hoạt bot', () => {
  const groupMessage = new GroupMessage(BOT_UID, {
    msgId: '7',
    uidFrom: '0',
    idTo: 'g1',
    ts: '1',
    content: '@Bot',
    mentions: [{ uid: '1000', pos: 0, len: 4, type: 0 }],
  });
  const message = normalizeZaloMessage(groupMessage, BOT_UID, 'live');
  assert.equal(message.isSelf, true);
  assert.equal(message.triggersBot, false);
});

test('rút chữ từ tin đính kèm', () => {
  assert.equal(extractReadableText({ title: 'baogia.pdf', href: 'http://x' }, 'share.file'), '[share.file] baogia.pdf');
  assert.equal(extractReadableText('abc', 'webchat'), 'abc');
});

test('so sánh msgId số lớn đúng theo giá trị số', () => {
  assert.equal(isMessageIdLessOrEqual('7300000000000000001', '7300000000000000002'), true);
  assert.equal(isMessageIdLessOrEqual('99', '100'), true);
});

test('dựng quote từ tin gốc', () => {
  const quote = buildQuoteFromRawMessage({ msgId: '1', cliMsgId: '2', uidFrom: '3', ts: '4', content: 'x', msgType: 'webchat' });
  assert.deepEqual(quote, {
    content: 'x',
    msgType: 'webchat',
    propertyExt: undefined,
    uidFrom: '3',
    msgId: '1',
    cliMsgId: '2',
    ts: '4',
    ttl: 0,
  });
  assert.equal(buildQuoteFromRawMessage(null), undefined);
});
