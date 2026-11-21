import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GroupMessage } from 'zca-js';
import { detectTrigger, stripBotMention, normalizeMessage, extractText, msgIdLte } from '../src/zalo/normalize.js';
import { buildMessages, toPlainText, chunkText } from '../src/prompt.js';
import { OpenWebUIClient } from '../src/openwebui.js';

const BOT = '1000';

test('detectTrigger: @tag đúng bot', () => {
  assert.equal(detectTrigger({ mentions: [{ uid: '1000', pos: 0, len: 4, type: 0 }], text: '@Bot hi' }, BOT), 'mention');
});

test('detectTrigger: tag người khác thì không gọi bot', () => {
  assert.equal(detectTrigger({ mentions: [{ uid: '2000', pos: 0, len: 4, type: 0 }], text: '@An hi' }, BOT), null);
});

test('detectTrigger: reply vào tin của bot', () => {
  assert.equal(detectTrigger({ quote: { ownerId: '1000' }, text: 'thế còn giá?' }, BOT, { replyOnQuoteToBot: true }), 'quote');
  assert.equal(detectTrigger({ quote: { ownerId: '1000' }, text: 'x' }, BOT, { replyOnQuoteToBot: false }), null);
});

test('detectTrigger: @All chỉ khi bật', () => {
  const m = { mentions: [{ uid: '-1', pos: 0, len: 4, type: 1 }], text: '@All' };
  assert.equal(detectTrigger(m, BOT), null);
  assert.equal(detectTrigger(m, BOT, { replyOnMentionAll: true }), 'mention_all');
});

test('detectTrigger: từ khoá', () => {
  assert.equal(detectTrigger({ text: 'Hỏi /BOT giá tour' }, BOT, { triggerKeywords: ['/bot'] }), 'keyword');
});

test('stripBotMention bỏ đúng đoạn tag bot', () => {
  const text = '@UrBox Bot cho hỏi giá @An nhé';
  const mentions = [
    { uid: '1000', pos: 0, len: 10, type: 0 },
    { uid: '2000', pos: 24, len: 3, type: 0 },
  ];
  assert.equal(stripBotMention(text, mentions, BOT), 'cho hỏi giá @An nhé');
});

test('normalizeMessage từ GroupMessage của zca-js', () => {
  const gm = new GroupMessage(BOT, {
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
  const m = normalizeMessage(gm, BOT, 'live');
  assert.equal(m.threadType, 'group');
  assert.equal(m.threadId, 'g1');
  assert.equal(m.triggersBot, true);
  assert.equal(m.trigger, 'mention');
  assert.equal(m.isSelf, false);
});

test('normalizeMessage: tin của chính bot không bao giờ trigger', () => {
  const gm = new GroupMessage(BOT, {
    msgId: '7', uidFrom: '0', idTo: 'g1', ts: '1', content: '@Bot',
    mentions: [{ uid: '1000', pos: 0, len: 4, type: 0 }],
  });
  const m = normalizeMessage(gm, BOT, 'live');
  assert.equal(m.isSelf, true);
  assert.equal(m.triggersBot, false);
});

test('extractText với đính kèm', () => {
  assert.equal(extractText({ title: 'baogia.pdf', href: 'http://x' }, 'share.file'), '[share.file] baogia.pdf');
  assert.equal(extractText('abc', 'webchat'), 'abc');
});

test('msgIdLte so sánh số lớn', () => {
  assert.equal(msgIdLte('7300000000000000001', '7300000000000000002'), true);
  assert.equal(msgIdLte('99', '100'), true); // so sánh chuỗi sẽ sai, BigInt đúng
});

test('buildMessages: ngữ cảnh + lịch sử hỏi đáp', () => {
  const { messages, question } = buildMessages({
    trigger: { msg_id: '3', text: '@Bot giá?', mentions: [{ uid: '1000', pos: 0, len: 4 }], sender_name: 'An' },
    botUid: BOT,
    groupName: 'Nhóm A',
    contextRows: [
      { msg_id: '1', sender_name: 'Bình', text: 'tour Đà Lạt', ts: 1732150000000, is_self: false },
      { msg_id: '3', sender_name: 'An', text: '@Bot giá?', ts: 1732150001000, is_self: false },
    ],
    previousQa: [{ question: 'q1', answer: 'a1' }],
  });
  assert.equal(question, 'giá?');
  assert.equal(messages.length, 3);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[1].role, 'assistant');
  assert.match(messages[2].content, /Bình: tour Đà Lạt/);
  assert.doesNotMatch(messages[2].content, /An: @Bot giá\?/); // tin trigger không lặp trong ngữ cảnh
});

test('toPlainText bỏ markdown', () => {
  assert.equal(toPlainText('## Giá\n**3.990.000đ**\n- Ăn sáng\n[Link](https://a.b)'), 'Giá\n3.990.000đ\n• Ăn sáng\nLink (https://a.b)');
});

test('chunkText chia tin dài', () => {
  const chunks = chunkText('a'.repeat(50) + '\n' + 'b'.repeat(50), 60);
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((c) => c.length <= 60));
});

test('OpenWebUIClient.messageText đọc content hoặc output[]', () => {
  assert.equal(OpenWebUIClient.messageText({ content: ' hi ' }), 'hi');
  assert.equal(
    OpenWebUIClient.messageText({ content: '', output: [{ type: 'function_call' }, { type: 'message', content: [{ type: 'output_text', text: 'xin chào' }] }] }),
    'xin chào',
  );
});
