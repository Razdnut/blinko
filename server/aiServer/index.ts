import '../lib/pdf-parse-wrapper';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { prisma } from '../prisma';
import { AiModelFactory } from './aiModelFactory';
import { ProgressResult } from '@shared/lib/types';
import { PDFLoader } from '@langchain/community/document_loaders/fs/pdf';
import { DocxLoader } from '@langchain/community/document_loaders/fs/docx';
import { CSVLoader } from '@langchain/community/document_loaders/fs/csv';
import { TextLoader } from 'langchain/document_loaders/fs/text';
import { UnstructuredLoader } from '@langchain/community/document_loaders/fs/unstructured';
import { BaseDocumentLoader } from '@langchain/core/document_loaders/base';
import { FileService } from '../lib/files';
import { Context } from '../context';
import { CreateNotification } from '../routerTrpc/notification';
import { NotificationType } from '@shared/lib/prismaZodType';
import { CoreMessage } from '@mastra/core';
import { MDocument } from '@mastra/rag';
import { embedMany } from 'ai';
import { RebuildEmbeddingJob } from '../jobs/rebuildEmbeddingJob';
import { userCaller } from '../routerTrpc/_app';

import { getAllPathTags } from '@server/lib/helper';
import { LibSQLVector } from '@mastra/libsql';
import { RuntimeContext } from "@mastra/core/di";
import path from 'path';
import { fetchWithProxy } from '../lib/proxy';

export function isImage(filePath: string): boolean {
  if (!filePath) return false;
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg'];
  return imageExtensions.some((ext) => filePath.toLowerCase().endsWith(ext));
}

export class AiService {
  static isImage = isImage;

  private static resolveOpenAIEndpoint(endpoint?: string, pathName?: string) {
    const base = (endpoint || 'https://api.openai.com/v1').replace(/\/$/, '');
    if (!pathName) {
      return base;
    }
    return `${base}${pathName.startsWith('/') ? pathName : `/${pathName}`}`;
  }

  private static detectMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
      case '.mp3':
        return 'audio/mpeg';
      case '.wav':
        return 'audio/wav';
      case '.m4a':
        return 'audio/mp4';
      case '.aac':
        return 'audio/aac';
      case '.ogg':
        return 'audio/ogg';
      case '.mp4':
        return 'audio/mp4';
      case '.webm':
      default:
        return 'audio/webm';
    }
  }

  static async loadFileContent(filePath: string): Promise<string> {
    try {
      let loader: BaseDocumentLoader;
      switch (true) {
        case filePath.endsWith('.pdf'):
          loader = new PDFLoader(filePath);
          break;
        case filePath.endsWith('.docx') || filePath.endsWith('.doc'):
          loader = new DocxLoader(filePath);
          break;
        case filePath.endsWith('.txt'):
          loader = new TextLoader(filePath);
          break;
        case filePath.endsWith('.csv'):
          console.log('load csv');
          loader = new CSVLoader(filePath);
          break;
        default:
          loader = new UnstructuredLoader(filePath);
      }
      const docs = await loader.load();
      return docs.map((doc) => doc.pageContent).join('\n');
    } catch (error) {
      console.error('File loading error:', error);
      throw new Error(`can not load file: ${filePath}`);
    }
    return '';
  }

  static async embeddingDeleteAll(id: number, VectorStore: LibSQLVector) {
    await VectorStore.truncateIndex({ indexName: 'blinko' });
  }

  static async embeddingDeleteAllAttachments(filePath: string, VectorStore: LibSQLVector) {
    await VectorStore.truncateIndex({ indexName: 'blinko' });
  }

  static async embeddingUpsert({ id, content, type, createTime, updatedAt }: { id: number; content: string; type: 'update' | 'insert'; createTime: Date; updatedAt?: Date }) {
    try {
      const { VectorStore, Embeddings } = await AiModelFactory.GetProvider();
      const config = await AiModelFactory.globalConfig();

      if (config.excludeEmbeddingTagId) {
        const tag = await prisma.tag.findUnique({ where: { id: config.excludeEmbeddingTagId } });
        if (tag && content.includes(tag.name)) {
          console.warn('this note is not allowed to be embedded:', tag.name);
          return { ok: false, msg: 'tag is not allowed to be embedded' };
        }
      }

      const note = await prisma.notes.findUnique({
        where: { id },
        select: { metadata: true, attachments: true }
      });

      const chunks = await MDocument.fromMarkdown(content).chunk();
      if (type == 'update') {
        AiModelFactory.queryAndDeleteVectorById(id);
      }

      const { embeddings } = await embedMany({
        values: chunks.map((chunk) => chunk.text + 'Create At: ' + createTime.toISOString() + ' Update At: ' + updatedAt?.toISOString()),
        model: Embeddings,
      });

      await VectorStore.upsert({
        indexName: 'blinko',
        vectors: embeddings,
        metadata: chunks?.map((chunk) => ({ text: chunk.text, id, noteId: id, createTime, updatedAt })),
      });

      try {
        await prisma.notes.update({
          where: { id },
          data: {
            metadata: {
              //@ts-ignore
              ...(note?.metadata || {}),
              isIndexed: true,
            },
            updatedAt,
          },
        });
      } catch (error) {
        console.log(error);
      }

      return { ok: true };
    } catch (error) {
      console.log(error, 'embeddingUpsert error');
      return { ok: false, error: error?.message };
    }
  }

  //api/file/123.pdf
  static async embeddingInsertAttachments({ id, updatedAt, filePath }: { id: number; updatedAt?: Date; filePath: string }) {
    try {
      const fileResult = await FileService.getFile(filePath);
      let content: string;
      try {
        if (AiService.isImage(filePath)) {
          content = await AiModelFactory.describeImage(fileResult.path);
        } else {
          content = await AiService.loadFileContent(fileResult.path);
        }
      } finally {
        // Clean up temporary file if needed
        if (fileResult.isTemporary && fileResult.cleanup) {
          await fileResult.cleanup();
        }
      }
      const { VectorStore, TokenTextSplitter, Embeddings } = await AiModelFactory.GetProvider();

      const doc = MDocument.fromText(content);
      const chunks = await doc.chunk();

      const { embeddings } = await embedMany({
        values: chunks.map((chunk) => chunk.text + 'Create At: ' + updatedAt?.toISOString() + ' Update At: ' + updatedAt?.toISOString()),
        model: Embeddings,
      });

      await VectorStore.upsert({
        indexName: 'blinko',
        vectors: embeddings,
        metadata: chunks?.map((chunk) => ({ text: chunk.text, id, noteId: id, isAttachment: true, updatedAt })),
      });

      try {
        const note = await prisma.notes.findUnique({
          where: { id },
          select: { metadata: true }
        });
        await prisma.notes.update({
          where: { id },
          data: {
            metadata: {
              //@ts-ignore
              ...(note?.metadata || {}),
              isIndexed: true,
              isAttachmentsIndexed: true,
            },
            updatedAt,
          },
        });
      } catch (error) {
        console.log(error);
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  }

  static async embeddingDelete({ id }: { id: number }) {
    AiModelFactory.queryAndDeleteVectorById(id);
    return { ok: true };
  }

  static async speechToText({ filePath, language }: { filePath: string; language?: string }) {
    const config = await AiModelFactory.globalConfig();
    if (!config.aiApiKey) {
      throw new Error('AI API key is not configured');
    }

    const fetcher = await fetchWithProxy();
    const audioBuffer = await FileService.getFileBuffer(filePath);
    const mimeType = AiService.detectMimeType(filePath);
    const fileName = path.basename(filePath) || `audio${path.extname(filePath) || '.webm'}`;

    const formData = new FormData();
    const blob = new Blob([audioBuffer], { type: mimeType });
    formData.append('file', blob, fileName);
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'json');
    if (language) {
      formData.append('language', language);
    }

    const url = AiService.resolveOpenAIEndpoint(config.aiApiEndpoint, '/audio/transcriptions');
    const response = await fetcher(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.aiApiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(`Transcription failed: ${response.status} ${response.statusText} ${errorBody}`.trim());
    }

    const data = await response.json();
    const text = typeof data.text === 'string' ? data.text.trim() : '';
    return { text };
  }

  static async summarizeTranscription({ text, prompt }: { text: string; prompt?: string }) {
    if (!text?.trim()) {
      throw new Error('No transcription provided');
    }

    const agent = await AiModelFactory.BaseChatAgent({ withTools: false, withOnlineSearch: false });
    const instructions = prompt?.trim() ||
      'You are a helpful assistant that summarizes voice note transcriptions. ' +
      'Provide a concise summary using short paragraphs or bullet points when appropriate. ' +
      'Preserve important details like dates, names, tasks and decisions. Respond in the same language as the input.';

    const result = await agent.generate([
      {
        role: 'system',
        content: instructions,
      },
      {
        role: 'user',
        content: text,
      },
    ]);

    return { summary: result.text?.trim() ?? '' };
  }

  static async *rebuildEmbeddingIndex({ force = false }: { force?: boolean }): AsyncGenerator<ProgressResult & { progress?: { current: number; total: number } }, void, unknown> {
    // This method is now a wrapper around the RebuildEmbeddingJob
    // We'll just return a simple message directing to use the job instead
    yield {
      type: 'info' as const,
      content: 'Rebuild embedding index task started - check task progress for details',
      progress: { current: 0, total: 0 },
    };

    // Start the job
    await RebuildEmbeddingJob.ForceRebuild(force);
  }

  static getChatHistory({ conversations }: { conversations: { role: string; content: string }[] }) {
    const conversationMessage = conversations.map((i) => {
      if (i.role == 'user') {
        return new HumanMessage(i.content);
      }
      return new AIMessage(i.content);
    });
    conversationMessage.pop();
    return conversationMessage;
  }

  static async enhanceQuery({ query, ctx }: { query: string; ctx: Context }) {
    try {
      const { notes } = await AiModelFactory.queryVector(query, Number(ctx.id));
      return notes;
    } catch (error) {
      console.error('Error in enhanceQuery:', error);
      return [];
    }
  }

  static async completions({
    question,
    conversations,
    withTools,
    withRAG = true,
    withOnline = false,
    systemPrompt,
    ctx,
  }: {
    question: string;
    conversations: CoreMessage[];
    withTools?: boolean;
    withRAG?: boolean;
    withOnline?: boolean;
    systemPrompt?: string;
    ctx: Context;
  }) {
    try {
      console.log('completions');
      conversations.push({
        role: 'user',
        content: question,
      });
      conversations.push({
        role: 'system',
        content: `Current user name: ${ctx.name}\n`,
      });
      if (systemPrompt) {
        conversations.push({
          role: 'system',
          content: systemPrompt,
        });
      }
      let ragNote: any[] = [];
      if (withRAG) {
        let { notes, aiContext } = await AiModelFactory.queryVector(question, Number(ctx.id));
        ragNote = notes;
        conversations.push({
          role: 'system',
          content: `This is the note content ${ragNote.map((i) => i.content).join('\n')} ${aiContext}`,
        });
      }
      console.log(conversations, 'conversations');
      const runtimeContext = new RuntimeContext();
      runtimeContext.set('accountId', Number(ctx.id));
      const agent = await AiModelFactory.BaseChatAgent({ withTools, withOnlineSearch: withOnline });
      const result = await agent.stream(conversations, { runtimeContext });
      return { result, notes: ragNote };
    } catch (error) {
      console.log(error);
      throw new Error(error);
    }
  }

  static async AIComment({ content, noteId }: { content: string; noteId: number }) {
    try {
      const note = await prisma.notes.findUnique({
        where: { id: noteId },
        select: { content: true, accountId: true },
      });

      if (!note) {
        throw new Error('Note not found');
      }

      const agent = await AiModelFactory.CommentAgent();
      const result = await agent.generate([
        {
          role: 'user',
          content: content,
        },
        {
          role: 'user',
          content: `This is the note content: ${note.content}`,
        },
      ]);

      const comment = await prisma.comments.create({
        data: {
          content: result.text.trim(),
          noteId,
          guestName: 'Blinko AI',
          guestIP: '',
          guestUA: '',
        },
        include: {
          account: {
            select: {
              id: true,
              name: true,
              nickname: true,
              image: true,
            },
          },
        },
      });
      await CreateNotification({
        accountId: note.accountId ?? 0,
        title: 'comment-notification',
        content: 'comment-notification',
        type: NotificationType.COMMENT,
      });
      return comment;
    } catch (error) {
      console.log(error);
      throw new Error(error);
    }
  }

  static async postProcessNote({ noteId, ctx }: { noteId: number; ctx: Context }) {
    try {
      const runtimeContext = new RuntimeContext();
      runtimeContext.set('accountId', ctx.id);

      const caller = userCaller(ctx);
      // Get the configuration
      const config = await AiModelFactory.globalConfig();

      // Check if post-processing is enabled
      if (!config.isUseAiPostProcessing) {
        return { success: false, message: 'AI post-processing not enabled' };
      }

      // Fetch the note
      const note = await prisma.notes.findUnique({
        where: { id: noteId },
        select: {
          content: true,
          accountId: true,
          type: true,
          tags: {
            include: {
              tag: true,
            },
          },
        },
      });
      let noteType = 'blinko'
      switch (note?.type) {
        case 0:
          noteType = 'blinko';
          break;
        case 1:
          noteType = 'note';
          break;
        case 2:
          noteType = 'todo';
          break;
        default:
          noteType = 'blinko';
      }

      if (!note) {
        return { success: false, message: 'Note not found' };
      }

      const processingMode = config.aiPostProcessingMode || 'comment';

      // Handle custom processing mode
      if (processingMode === 'custom') {
        // Get all tags for tag replacement
        const tags = await getAllPathTags();
        const tagsList = tags.join(', ');

        // Get custom prompt and replace variables
        let customPrompt = config.aiCustomPrompt || 'Analyze the following note content and provide feedback.';
        customPrompt = customPrompt.replace('{tags}', tagsList).replace('{note}', note.content);
        const withOnlineSearch = !!config.tavilyApiKey;
        // Process with AI using BaseChatAgent with tools
   
        const agent = await AiModelFactory.BaseChatAgent({ withTools: true, withOnlineSearch: withOnlineSearch });
        const result = await agent.generate([
          {
            role: 'system',
            content: `You are an AI assistant that helps to process notes. You MUST use the available tools to complete your task.
This is a one-time conversation, so you MUST take action immediately using the tools provided.
You have access to tools that can help you modify notes, add comments, or create new notes.
DO NOT just respond with suggestions or analysis - you MUST use the appropriate tool to implement your changes.
If you need to add a comment, use the createCommentTool.
If you need to update the note, use the updateBlinkoTool.
If you need to create a new note, use the upsertBlinkoTool.
Remember: ALWAYS use tools to implement your suggestions rather than just describing what should be done.`
          },
          {
            role: 'user',
            content: `Current user name: ${ctx.name}\n${customPrompt}\n\nNote ID: ${noteId}\nNote content:\n${note.content}
            Current Note Type: ${noteType}`
          }
        ], {
          runtimeContext
        });

        return { success: true, message: 'Custom processing completed' };
      }

      // Get the custom prompt, or use default
      const prompt = config.aiCommentPrompt || 'Analyze the following note content. Extract key topics as tags and provide a brief summary of the main points.';

      // Process with AI
      const agent = await AiModelFactory.CommentAgent();
      const result = await agent.generate([
        {
          role: 'user',
          content: prompt,
        },
        {
          role: 'user',
          content: `Note content: ${note.content}`,
        },
      ]);

      const aiResponse = result.text.trim();

      // Handle based on the processing mode
      if (processingMode === 'comment' || processingMode === 'both') {
        // Add comment
        await prisma.comments.create({
          data: {
            content: aiResponse,
            noteId,
            guestName: 'Blinko AI',
            guestIP: '',
            guestUA: '',
          },
        });

        await CreateNotification({
          accountId: note.accountId ?? 0,
          title: 'ai-post-processing-notification',
          content: 'ai-processed-your-note',
          type: NotificationType.COMMENT,
        });
      }

      if (processingMode === 'tags' || processingMode === 'both') {
        try {
          let suggestedTags: string[] = [];
          // If no clear tag format, process with an agent specialized for tag extraction
          const aiTagsPrompt = config.aiTagsPrompt
          let tagAgent: any;
          if (aiTagsPrompt != '') {
            tagAgent = await AiModelFactory.TagAgent(aiTagsPrompt);
          } else {
            tagAgent = await AiModelFactory.TagAgent();
          }
          const tags = await getAllPathTags();
          const result = await tagAgent.generate(
            `Existing tags list:  [${tags.join(', ')}]\n Note content:\n${note.content}`
          )
          suggestedTags = result.text.split(',').map((tag) => tag.trim());
          // Filter out empty tags and limit to 5 tags max
          suggestedTags = suggestedTags.filter(Boolean).slice(0, 5);
          caller.notes.upsert({
            id: noteId,
            content: note.content + '\n' + suggestedTags.join(' '),
          });
        } catch (error) {
          console.error('Error processing tags:', error);
        }
      }

      if (processingMode === 'smartEdit' || processingMode === 'both') {
        try {
          const smartEditPrompt = config.aiSmartEditPrompt || 'Improve this note by organizing content, adding headers, and enhancing readability.';
          const agent = await AiModelFactory.BaseChatAgent({ withTools: true });
          const result = await agent.generate([
            {
              role: 'system',
              content: `You are an AI assistant that helps to improve notes. You'll be provided with a note content, and your task is to enhance it according to instructions. You have access to tools that can help you modify the note. Use these tools to make the requested improvements.`
            },
            {
              role: 'user',
              content: `\nCurrent user id: ${ctx.id}\nCurrent user name: ${ctx.name}\n${smartEditPrompt}\n\nNote ID: ${noteId}\nNote content:\n${note.content}`
            }
          ], {
            runtimeContext
          });
          await prisma.comments.create({
            data: {
              content: result.text,
              noteId,
              guestName: 'Blinko AI',
              guestIP: '',
              guestUA: '',
            },
          });
        } catch (error) {
          console.error('Error during smart edit:', error);
          await prisma.comments.create({
            data: {
              content: `⚠️ **Smart Edit Error**\n\nI encountered an error while trying to edit this note. This may happen if the AI model doesn't support function calling or if there was an issue with the edit process.\n\nError details: ${error.message}`,
              noteId,
              guestName: 'Blinko AI',
              guestIP: '',
              guestUA: '',
            },
          });
        }
      }

      return { success: true, message: 'Note processed successfully' };
    } catch (error) {
      console.error('Error in post-processing note:', error);
      return { success: false, message: error.message || 'Unknown error' };
    }
  }
}
