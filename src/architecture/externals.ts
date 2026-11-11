/** Which external system a package belongs to, as data. Add a system with one row. */
import type { ExternalKind } from '../types.ts';

/** A known external system and the packages that reach it. `*` matches any characters. */
export interface KnownExternal {
  id: string;
  title: string;
  packages: string[];
}

/** Systems a reader of an architecture wants to see by name: databases, models, clouds, queues. */
export const KNOWN_EXTERNALS: KnownExternal[] = [
  { id: 'ai_sdk', title: 'AI SDK', packages: ['ai', '@ai-sdk/*'] },
  { id: 'openai', title: 'OpenAI API', packages: ['openai'] },
  { id: 'anthropic', title: 'Anthropic API', packages: ['@anthropic-ai/*', 'anthropic'] },
  { id: 'langchain', title: 'LangChain', packages: ['langchain', '@langchain/*'] },
  {
    id: 'postgres',
    title: 'PostgreSQL',
    packages: [
      'pg',
      'postgres',
      'psycopg2',
      'psycopg',
      'asyncpg',
      '@neondatabase/*',
      'github.com/jackc/pgx',
    ],
  },
  {
    id: 'mysql',
    title: 'MySQL',
    packages: ['mysql', 'mysql2', 'pymysql', 'github.com/go-sql-driver/mysql'],
  },
  {
    id: 'sqlite',
    title: 'SQLite',
    packages: ['better-sqlite3', 'sqlite3', 'sqlite', 'node:sqlite', 'rusqlite'],
  },
  { id: 'mongodb', title: 'MongoDB', packages: ['mongodb', 'mongoose', 'pymongo', 'motor'] },
  {
    id: 'redis',
    title: 'Redis',
    packages: ['redis', 'ioredis', '@upstash/redis', 'github.com/redis/go-redis'],
  },
  { id: 'prisma', title: 'Prisma', packages: ['@prisma/client', 'prisma'] },
  { id: 'drizzle', title: 'Drizzle ORM', packages: ['drizzle-orm'] },
  { id: 'sqlalchemy', title: 'SQLAlchemy', packages: ['sqlalchemy'] },
  {
    id: 'aws',
    title: 'AWS',
    packages: ['@aws-sdk/*', 'aws-sdk', 'boto3', 'botocore', 'github.com/aws/aws-sdk-go-v2'],
  },
  { id: 'gcp', title: 'Google Cloud', packages: ['@google-cloud/*', 'google.cloud'] },
  { id: 'azure', title: 'Azure', packages: ['@azure/*', 'azure'] },
  { id: 'stripe', title: 'Stripe', packages: ['stripe'] },
  {
    id: 'kafka',
    title: 'Kafka',
    packages: ['kafkajs', 'kafka', 'confluent_kafka', 'github.com/segmentio/kafka-go'],
  },
  { id: 'rabbitmq', title: 'RabbitMQ', packages: ['amqplib', 'pika'] },
  { id: 'grpc', title: 'gRPC', packages: ['@grpc/*', 'grpc', 'grpcio', 'google.golang.org/grpc'] },
  { id: 'graphql', title: 'GraphQL', packages: ['graphql', '@apollo/*'] },
  {
    id: 'http_client',
    title: 'HTTP client',
    packages: ['axios', 'node-fetch', 'got', 'requests', 'httpx', 'reqwest'],
  },
  { id: 'react', title: 'React', packages: ['react', 'react-dom'] },
  { id: 'nextjs', title: 'Next.js', packages: ['next'] },
  { id: 'express', title: 'Express', packages: ['express'] },
  { id: 'fastify', title: 'Fastify', packages: ['fastify'] },
  { id: 'hono', title: 'Hono', packages: ['hono'] },
  { id: 'fastapi', title: 'FastAPI', packages: ['fastapi'] },
  { id: 'django', title: 'Django', packages: ['django'] },
  { id: 'flask', title: 'Flask', packages: ['flask'] },
  { id: 'gin', title: 'Gin', packages: ['github.com/gin-gonic/gin'] },
  { id: 'tokio', title: 'Tokio', packages: ['tokio'] },
];

/** Python's standard library modules that projects import most, which are runtime, not packages. */
const PYTHON_RUNTIME = new Set(
  'abc argparse asyncio base64 collections contextlib copy csv dataclasses datetime decimal enum functools glob hashlib heapq http importlib inspect io itertools json logging math os pathlib pickle platform queue random re shutil signal socket sqlite3 string subprocess sys tempfile textwrap threading time traceback types typing unittest urllib uuid warnings weakref'.split(
    ' ',
  ),
);

const escapeRegExp = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/** Whether a package name matches a pattern such as `@ai-sdk/*` or `node:*`. */
export function matchesPackage(pattern: string, name: string): boolean {
  const expression = `^${pattern.split('*').map(escapeRegExp).join('.*')}$`;
  return new RegExp(expression).test(name);
}

/** The id an unknown package gets: its name with only letters, digits and `_`. */
export const packageId = (name: string) =>
  name
    .replace(/^@/, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase() || 'package';

/** Classifies a package as a known system, the language's runtime, or a library. */
export function classifyPackage(name: string): { id: string; title: string; kind: ExternalKind } {
  const known = KNOWN_EXTERNALS.find(({ packages }) =>
    packages.some((pattern) => matchesPackage(pattern, name)),
  );
  if (known) return { id: known.id, title: known.title, kind: 'system' };
  if (/^(node|go|rust):/.test(name) || PYTHON_RUNTIME.has(name)) {
    return { id: name, title: name, kind: 'runtime' };
  }
  return { id: packageId(name), title: name, kind: 'library' };
}
