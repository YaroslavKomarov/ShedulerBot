import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../llm/client.js', () => ({
  llmClient: {
    audio: {
      transcriptions: {
        create: vi.fn(),
      },
    },
  },
  WHISPER_MODEL: 'openai/whisper-large-v3',
}))

import { transcribeVoice } from '../middleware/voice.js'
import { llmClient } from '../../llm/client.js'

const mockTranscribe = vi.mocked(llmClient.audio.transcriptions.create)

// We need to mock fetch globally
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function makeFakeArrayBuffer(): ArrayBuffer {
  const buf = new ArrayBuffer(8)
  new Uint8Array(buf).set([79, 103, 103, 83, 0, 2, 0, 0]) // fake OGG header bytes
  return buf
}

function makeCtx(overrides?: Partial<{
  getFile: () => Promise<{ file_path?: string }>
  voice: { file_id: string }
  fromId: number
}>) {
  const defaults = {
    getFile: vi.fn().mockResolvedValue({ file_path: 'voice/file_123.ogg' }),
    voice: { file_id: 'file_abc123' },
    fromId: 42,
  }
  const opts = { ...defaults, ...overrides }
  return {
    from: { id: opts.fromId },
    message: { voice: opts.voice },
    getFile: opts.getFile,
  } as any
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.TELEGRAM_BOT_TOKEN = 'test_token'

  // Default fetch mock: returns ok response with fake audio bytes
  mockFetch.mockResolvedValue({
    ok: true,
    arrayBuffer: vi.fn().mockResolvedValue(makeFakeArrayBuffer()),
  })

  // Default transcription mock
  mockTranscribe.mockResolvedValue({ text: 'купить молоко' } as any)
})

describe('transcribeVoice', () => {
  it('returns transcription text on success', async () => {
    const ctx = makeCtx()
    const result = await transcribeVoice(ctx)
    expect(result).toBe('купить молоко')
  })

  it('calls Telegram getFile and downloads from correct URL', async () => {
    const ctx = makeCtx()
    await transcribeVoice(ctx)

    expect(ctx.getFile).toHaveBeenCalledOnce()
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.telegram.org/file/bottest_token/voice/file_123.ogg',
    )
  })

  it('calls llmClient.audio.transcriptions.create with correct model', async () => {
    const ctx = makeCtx()
    await transcribeVoice(ctx)

    expect(mockTranscribe).toHaveBeenCalledOnce()
    const callArg = mockTranscribe.mock.calls[0][0]
    expect(callArg.model).toBe('openai/whisper-large-v3')
    expect(callArg.file).toBeInstanceOf(File)
    expect(callArg.file.name).toBe('voice.ogg')
    expect(callArg.file.type).toBe('audio/ogg')
  })

  it('throws when ctx.getFile() throws', async () => {
    const ctx = makeCtx({
      getFile: vi.fn().mockRejectedValue(new Error('Telegram API error')),
    })
    await expect(transcribeVoice(ctx)).rejects.toThrow('Telegram API error')
  })

  it('throws when fetch returns non-ok status', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404 })
    const ctx = makeCtx()
    await expect(transcribeVoice(ctx)).rejects.toThrow('HTTP 404')
  })

  it('throws when llmClient.audio.transcriptions.create throws', async () => {
    mockTranscribe.mockRejectedValue(new Error('OpenRouter quota exceeded'))
    const ctx = makeCtx()
    await expect(transcribeVoice(ctx)).rejects.toThrow('OpenRouter quota exceeded')
  })
})
