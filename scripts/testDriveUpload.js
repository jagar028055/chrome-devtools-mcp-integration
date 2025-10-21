#!/usr/bin/env node
const assert = require('assert');
const { uploadPdfBuffer, ensureFolderPath } = require('./fulltext/drive');

async function runUploadTest() {
  let createCalls = 0;
  let shareCalls = 0;
  const recorded = [];
  const drive = {
    files: {
      create: async (payload) => {
        createCalls += 1;
        if (createCalls < 3) {
          const error = new Error('transient error');
          error.code = 500;
          throw error;
        }
        recorded.push(payload);
        return {
          data: {
            id: 'fake-drive-id',
            name: payload.requestBody.name,
            mimeType: payload.requestBody.mimeType || 'application/pdf',
            webViewLink: 'https://example.com/view',
            createdTime: '2025-10-04T00:00:00Z'
          }
        };
      }
    },
    permissions: {
      create: async () => {
        shareCalls += 1;
        throw new Error('share failed');
      }
    }
  };

  const buffer = Buffer.from('%PDF-1.4\n%TEST PDF\n', 'utf8');
  const readStream = async (stream) => {
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  };
  const result = await uploadPdfBuffer(drive, {
    folderId: 'folder-123',
    fileName: 'report.pdf',
    buffer,
    retry: { attempts: 3, initialDelayMs: 10 },
    share: {
      shareAnyone: true,
      ignoreShareErrors: true,
      debug: false
    }
  });

  assert.strictEqual(result.id, 'fake-drive-id', 'DriveファイルIDが期待値と異なります');
  assert.strictEqual(createCalls, 3, 'リトライ回数が期待値と異なります');
  assert.strictEqual(shareCalls, 1, '共有設定が実行されませんでした');
  assert.strictEqual(recorded[0].requestBody.parents[0], 'folder-123', 'フォルダ指定が正しくありません');
  assert.strictEqual(recorded[0].requestBody.name, 'report.pdf', 'ファイル名が一致しません');
  const uploadedBuffer = await readStream(recorded[0].media.body);
  assert.strictEqual(uploadedBuffer.equals(buffer), true, 'アップロードバッファが一致しません');

  await assert.rejects(
    () => uploadPdfBuffer(drive, { folderId: 'folder-123', fileName: 'empty.pdf', buffer: Buffer.alloc(0) }),
    /PDFバッファが空です/
  );
}

async function runEnsureFolderTest() {
  let createCalls = 0;
  let listCalls = 0;
  const listResponses = [[], []];
  const createIds = ['NomuraReports-id', '2025-10-04-id'];
  const drive = {
    files: {
      list: async () => ({ data: { files: listResponses[listCalls++] || [] } }),
      create: async ({ requestBody }) => {
        createCalls += 1;
        return { data: { id: createIds[createCalls - 1] } };
      }
    }
  };

  const folderId = await ensureFolderPath(drive, {
    baseFolderId: 'root',
    segments: ['NomuraReports', '2025-10-04'],
    debug: false
  });

  assert.strictEqual(folderId, '2025-10-04-id', '最終フォルダIDが期待値と異なります');
  assert.strictEqual(createCalls, 2, 'フォルダ作成回数が期待値と異なります');
  assert.strictEqual(listCalls, 2, 'フォルダ検索回数が期待値と異なります');
}

async function run() {
  await runUploadTest();
  await runEnsureFolderTest();
  console.log('✅ Driveユーティリティテスト成功');
}

run().catch((error) => {
  console.error('❌ テスト失敗:', error);
  process.exitCode = 1;
});
