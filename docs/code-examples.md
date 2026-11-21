# 代码范例

## 事务回调放在操作入口

下面的操作放在 `document-store.ts`，由它拥有 ORM 和事务。当回调体是这项持久化操作的唯一主线，就地写清权限检查、查询和返回。业务入口通过这项具名操作读取数据。

```ts
export function listDocuments({
  db,
  folderId,
  userId,
}: ListDocumentsInput): Promise<readonly Document[] | null> {
  return db.transaction(async (transaction) => {
    const folder = await readAccessibleFolder({ transaction, folderId, userId });
    if (!folder) return null;

    return readDocuments({ transaction, folderId: folder.id });
  });
}
```

## 注册和执行各有清楚的阅读顺序

当注册处有多条路由或事件，具名处理函数让调用表保持紧凑。处理函数可以捕获当前依赖，并依次解析输入、调用业务操作、映射结果。独立的转换函数放在模块级。

```ts
export function registerDocumentRoutes(routes: Routes, documents: DocumentStore): void {
  routes.get('/documents/:id', getDocument);
  routes.delete('/documents/:id', deleteDocument);

  async function getDocument(request: RequestContext) {
    const id = parseDocumentId(request.params.id);
    const document = await documents.read(id);

    return document ? request.json(document) : request.notFound();
  }

  async function deleteDocument(request: RequestContext) {
    const id = parseDocumentId(request.params.id);
    const deleted = await documents.remove(id);

    return deleted ? request.noContent() : request.notFound();
  }
}
```

## 词法作用域表达资源释放时机

需要在释放资源后提交结果时，让作用域明确结束边界。资源模块负责关闭与取消，执行入口负责决定结果何时可以提交。

```ts
export async function prepareReport(input: ReportInput): Promise<Report> {
  let report: Report;
  {
    await using reader = await openReportSource(input.source);
    report = await readReport({ reader, signal: input.signal });
  }

  await recordReport(report);
  return report;
}
```

## 校验输入后使用解析结果

输入 schema 提供规则与类型。入口读取运行时数据后立刻解析，内部操作使用解析出来的值。外部字段名可以在入口转换为代码使用的命名。

```ts
const preferencesSchema = z.object({
  pageSize: z.number().int().min(1).max(100).default(20),
});

type Preferences = z.infer<typeof preferencesSchema>;

export function readPreferences(text: string): Preferences {
  const raw: unknown = JSON.parse(text);

  return preferencesSchema.parse(raw);
}
```
