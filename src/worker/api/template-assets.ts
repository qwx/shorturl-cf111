// src/worker/api/template-assets.ts
import { Hono } from "hono";
import { ErrorCode, HttpResponseJsonBody, Variables } from "../util";

// ============ 类型定义 ============

interface TemplateAsset {
    id: number;
    asset_prefix: string;
    filename: string;
    content_type: string | null;
    size: number | null;
    checksum: string | null;
    storage_type: number;
    r2_key: string | null;
    is_public: number;
    alt_text: string | null;
    created_at: number;
    updated_at: number | null;
}

/** 列表返回时不包含 content（BLOB太大） */
type TemplateAssetListItem = Omit<TemplateAsset, "content">;

interface AssetListResponse {
    results: TemplateAssetListItem[];
    pagination: {
        page: number;
        pageSize: number;
        total: number;
        totalPages: number;
    };
}

/** 树节点：文件夹或文件 */
interface TreeNode {
    name: string;
    type: "folder" | "file";
    path: string; // 相对于 prefix 的完整路径
    children?: TreeNode[];
    asset?: TemplateAssetListItem; // 仅 type=file 时
}

interface TreeResponse {
    prefix: string;
    tree: TreeNode[];
    total: number;
}

type DBParam = string | number | null;

const app = new Hono<{ Variables: Variables; Bindings: Env }>();

// ============ 辅助函数 ============

/** 生成 R2 key: prefix/filename */
function buildR2Key(prefix: string, filename: string): string {
    return `${prefix}/${filename}`;
}

/** 计算 SHA-256 hex */
async function sha256Hex(data: ArrayBuffer): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(hash)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

/** 将扁平文件列表构建为树结构 */
function buildTree(assets: TemplateAssetListItem[]): TreeNode[] {
    const root: TreeNode[] = [];

    for (const asset of assets) {
        const parts = asset.filename.split("/");
        let current = root;

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const isFile = i === parts.length - 1;
            const pathSoFar = parts.slice(0, i + 1).join("/");

            if (isFile) {
                current.push({
                    name: part,
                    type: "file",
                    path: pathSoFar,
                    asset,
                });
            } else {
                let folder = current.find(
                    (n) => n.type === "folder" && n.name === part
                );
                if (!folder) {
                    folder = {
                        name: part,
                        type: "folder",
                        path: pathSoFar,
                        children: [],
                    };
                    current.push(folder);
                }
                current = folder.children!;
            }
        }
    }

    return root;
}

// ============ 接口 ============

/**
 * GET /list
 * 获取指定 prefix 下的资源列表（分页）
 * query: prefix (必填), page, pageSize, filename (模糊搜索)
 */
app.get("/list", async (c) => {
    try {
        const db = c.env.shorturl;
        const prefix = c.req.query("prefix");

        if (!prefix) {
            return c.json<HttpResponseJsonBody>(
                { code: ErrorCode.DATA_INPUT_ERROR, message: "prefix 不能为空" },
                400
            );
        }

        const page = parseInt(c.req.query("page") || "1");
        const pageSize = parseInt(c.req.query("pageSize") || "50");
        const offset = (page - 1) * pageSize;
        const filenameSearch = c.req.query("filename") || "";

        let countSql = `SELECT COUNT(*) as total FROM template_assets WHERE asset_prefix = ?`;
        let dataSql = `SELECT id, asset_prefix, filename, content_type, size, checksum,
                               storage_type, r2_key, is_public, alt_text, created_at, updated_at
                        FROM template_assets WHERE asset_prefix = ?`;
        const params: DBParam[] = [prefix];

        if (filenameSearch) {
            countSql += ` AND filename LIKE ?`;
            dataSql += ` AND filename LIKE ?`;
            params.push(`%${filenameSearch}%`);
        }

        dataSql += ` ORDER BY filename ASC LIMIT ? OFFSET ?`;

        const countResult = await db
            .prepare(countSql)
            .bind(...params)
            .first<{ total: number }>();
        const total = countResult?.total || 0;

        const result = await db
            .prepare(dataSql)
            .bind(...params, pageSize, offset)
            .all();

        return c.json<HttpResponseJsonBody<AssetListResponse>>({
            code: ErrorCode.SUCCESS,
            message: "查询成功",
            data: {
                results: result.results as unknown as TemplateAssetListItem[],
                pagination: {
                    page,
                    pageSize,
                    total,
                    totalPages: Math.ceil(total / pageSize),
                },
            },
        });
    } catch (error) {
        console.error("查询资源列表失败:", error);
        return c.json<HttpResponseJsonBody>(
            { code: ErrorCode.UNKNOWN_ERROR, message: "查询资源列表失败" },
            500
        );
    }
});

/**
 * GET /tree
 * 获取指定 prefix 下的资源树结构
 * query: prefix (必填)
 */
app.get("/tree", async (c) => {
    try {
        const db = c.env.shorturl;
        const prefix = c.req.query("prefix");

        if (!prefix) {
            return c.json<HttpResponseJsonBody>(
                { code: ErrorCode.DATA_INPUT_ERROR, message: "prefix 不能为空" },
                400
            );
        }

        const result = await db
            .prepare(
                `SELECT id, asset_prefix, filename, content_type, size, checksum,
                        storage_type, r2_key, is_public, alt_text, created_at, updated_at
                 FROM template_assets
                 WHERE asset_prefix = ?
                 ORDER BY filename ASC`
            )
            .bind(prefix)
            .all();

        const assets = result.results as unknown as TemplateAssetListItem[];
        const tree = buildTree(assets);

        return c.json<HttpResponseJsonBody<TreeResponse>>({
            code: ErrorCode.SUCCESS,
            message: "查询成功",
            data: { prefix, tree, total: assets.length },
        });
    } catch (error) {
        console.error("查询资源树失败:", error);
        return c.json<HttpResponseJsonBody>(
            { code: ErrorCode.UNKNOWN_ERROR, message: "查询资源树失败" },
            500
        );
    }
});

/**
 * GET /detail/:id
 * 获取单个资源详情（不含 BLOB content）
 */
app.get("/detail/:id", async (c) => {
    try {
        const db = c.env.shorturl;
        const id = parseInt(c.req.param("id"));

        if (isNaN(id)) {
            return c.json<HttpResponseJsonBody>(
                { code: ErrorCode.DATA_INPUT_ERROR, message: "无效的资源 ID" },
                400
            );
        }

        const asset = await db
            .prepare(
                `SELECT id, asset_prefix, filename, content_type, size, checksum,
                        storage_type, r2_key, is_public, alt_text, created_at, updated_at
                 FROM template_assets WHERE id = ?`
            )
            .bind(id)
            .first<TemplateAssetListItem>();

        if (!asset) {
            return c.json<HttpResponseJsonBody>(
                { code: ErrorCode.DATA_INPUT_ERROR, message: "资源不存在" },
                404
            );
        }

        return c.json<HttpResponseJsonBody<TemplateAssetListItem>>({
            code: ErrorCode.SUCCESS,
            message: "查询成功",
            data: asset,
        });
    } catch (error) {
        console.error("查询资源详情失败:", error);
        return c.json<HttpResponseJsonBody>(
            { code: ErrorCode.UNKNOWN_ERROR, message: "查询资源详情失败" },
            500
        );
    }
});

/**
 * GET /download/:id
 * 下载指定资源的文件内容
 * 根据 storage_type 从数据库或 R2 读取文件并返回二进制流
 */
app.get("/download/:id", async (c) => {
    try {
        const db = c.env.shorturl;
        const id = parseInt(c.req.param("id"));

        if (isNaN(id)) {
            return c.json<HttpResponseJsonBody>(
                { code: ErrorCode.DATA_INPUT_ERROR, message: "无效的资源 ID" },
                400
            );
        }

        const asset = await db
            .prepare(
                `SELECT id, asset_prefix, filename, content_type, size,
                        storage_type, content, r2_key
                 FROM template_assets WHERE id = ?`
            )
            .bind(id)
            .first<{
                id: number;
                asset_prefix: string;
                filename: string;
                content_type: string | null;
                size: number | null;
                storage_type: number;
                content: ArrayBuffer | null;
                r2_key: string | null;
            }>();

        if (!asset) {
            return c.json<HttpResponseJsonBody>(
                { code: ErrorCode.DATA_INPUT_ERROR, message: "资源不存在" },
                404
            );
        }

        const contentType = asset.content_type || "application/octet-stream";
        // 从 filename 中取最后一段作为下载文件名
        const downloadName = asset.filename.split("/").pop() || asset.filename;

        if (asset.storage_type === 0) {
            // 从数据库读取 BLOB
            if (!asset.content) {
                return c.json<HttpResponseJsonBody>(
                    { code: ErrorCode.UNKNOWN_ERROR, message: "文件内容为空" },
                    404
                );
            }
            const buffer = new Uint8Array(asset.content);
            return new Response(buffer, {
                headers: {
                    "Content-Type": contentType,
                    "Content-Length": String(buffer.byteLength),
                    "Content-Disposition": `attachment; filename="${encodeURIComponent(downloadName)}"`,
                    "Cache-Control": "no-cache",
                },
            });
        } else if (asset.storage_type === 1) {
            // 从 R2 读取
            const bucket = c.env.R2_BUCKET;
            if (!asset.r2_key || !bucket) {
                return c.json<HttpResponseJsonBody>(
                    { code: ErrorCode.UNKNOWN_ERROR, message: "R2 存储配置异常或 r2_key 为空" },
                    500
                );
            }

            const object = await bucket.get(asset.r2_key);
            if (!object) {
                return c.json<HttpResponseJsonBody>(
                    { code: ErrorCode.UNKNOWN_ERROR, message: "R2 中未找到该文件" },
                    404
                );
            }

            const headers = new Headers();
            object.writeHttpMetadata(headers);
            headers.set("Content-Type", contentType);
            headers.set("Content-Disposition", `attachment; filename="${encodeURIComponent(downloadName)}"`);
            headers.set("Cache-Control", "no-cache");
            headers.set("ETag", object.httpEtag);

            return new Response(object.body, { headers });
        }

        return c.json<HttpResponseJsonBody>(
            { code: ErrorCode.UNKNOWN_ERROR, message: "未知的存储类型" },
            500
        );
    } catch (error) {
        console.error("下载资源失败:", error);
        return c.json<HttpResponseJsonBody>(
            { code: ErrorCode.UNKNOWN_ERROR, message: "下载资源失败" },
            500
        );
    }
});

/**
 * POST /upload/db
 * 上传文件到数据库存储（适用小文件）
 * FormData: file, prefix, filename?, is_public?, alt_text?
 */
app.post("/upload/db", async (c) => {
    try {
        const db = c.env.shorturl;
        const formData = await c.req.formData();

        const file = formData.get("file") as File | null;
        const prefix = formData.get("prefix") as string | null;
        let filename = (formData.get("filename") as string | null) || file?.name;
        const isPublic = parseInt(
            (formData.get("is_public") as string) || "0"
        );
        const altText = formData.get("alt_text") as string | null;

        if (!file || !prefix || !filename) {
            return c.json<HttpResponseJsonBody>(
                {
                    code: ErrorCode.DATA_INPUT_ERROR,
                    message: "file、prefix、filename 不能为空",
                },
                400
            );
        }

        // 规范化 filename：去掉首尾斜杠
        filename = filename.replace(/^\/+|\/+$/g, "");

        const buffer = await file.arrayBuffer();
        const checksum = await sha256Hex(buffer);
        const contentType = file.type || "application/octet-stream";
        const now = Math.floor(Date.now() / 1000);

        // 检查是否已存在同 prefix + filename
        const existing = await db
            .prepare(
                `SELECT id FROM template_assets WHERE asset_prefix = ? AND filename = ?`
            )
            .bind(prefix, filename)
            .first<{ id: number }>();

        if (existing) {
            // 更新已有记录
            await db
                .prepare(
                    `UPDATE template_assets
                     SET content = ?, content_type = ?, size = ?, checksum = ?,
                         storage_type = 0, r2_key = NULL, is_public = ?, alt_text = ?, updated_at = ?
                     WHERE id = ?`
                )
                .bind(
                    buffer,
                    contentType,
                    buffer.byteLength,
                    checksum,
                    isPublic,
                    altText,
                    now,
                    existing.id
                )
                .run();

            const updated = await db
                .prepare(
                    `SELECT id, asset_prefix, filename, content_type, size, checksum,
                            storage_type, r2_key, is_public, alt_text, created_at, updated_at
                     FROM template_assets WHERE id = ?`
                )
                .bind(existing.id)
                .first<TemplateAssetListItem>();

            return c.json<HttpResponseJsonBody<TemplateAssetListItem>>({
                code: ErrorCode.SUCCESS,
                message: "资源更新成功",
                data: updated!,
            });
        }

        // 新增记录
        const result = await db
            .prepare(
                `INSERT INTO template_assets
                     (asset_prefix, filename, content_type, size, checksum,
                      storage_type, content, r2_key, is_public, alt_text, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, 0, ?, NULL, ?, ?, ?, ?)`
            )
            .bind(
                prefix,
                filename,
                contentType,
                buffer.byteLength,
                checksum,
                buffer,
                isPublic,
                altText,
                now,
                now
            )
            .run();

        const newAsset = await db
            .prepare(
                `SELECT id, asset_prefix, filename, content_type, size, checksum,
                        storage_type, r2_key, is_public, alt_text, created_at, updated_at
                 FROM template_assets WHERE id = ?`
            )
            .bind(result.meta.last_row_id)
            .first<TemplateAssetListItem>();

        return c.json<HttpResponseJsonBody<TemplateAssetListItem>>(
            { code: ErrorCode.SUCCESS, message: "资源上传成功", data: newAsset! },
            201
        );
    } catch (error) {
        console.error("上传资源到数据库失败:", error);
        return c.json<HttpResponseJsonBody>(
            { code: ErrorCode.UNKNOWN_ERROR, message: "上传资源失败" },
            500
        );
    }
});

/**
 * POST /upload/r2
 * 直接上传文件到 R2（< 50MB）
 * FormData: file, prefix, filename?, is_public?, alt_text?
 */
app.post("/upload/r2", async (c) => {
    try {
        const db = c.env.shorturl;
        const bucket = c.env.R2_BUCKET;

        if (!bucket) {
            return c.json<HttpResponseJsonBody>(
                { code: ErrorCode.UNKNOWN_ERROR, message: "R2 存储桶未配置" },
                500
            );
        }

        const formData = await c.req.formData();
        const file = formData.get("file") as File | null;
        const prefix = formData.get("prefix") as string | null;
        let filename = (formData.get("filename") as string | null) || file?.name;
        const isPublic = parseInt(
            (formData.get("is_public") as string) || "0"
        );
        const altText = formData.get("alt_text") as string | null;

        if (!file || !prefix || !filename) {
            return c.json<HttpResponseJsonBody>(
                {
                    code: ErrorCode.DATA_INPUT_ERROR,
                    message: "file、prefix、filename 不能为空",
                },
                400
            );
        }

        filename = filename.replace(/^\/+|\/+$/g, "");

        const buffer = await file.arrayBuffer();
        const checksum = await sha256Hex(buffer);
        const contentType = file.type || "application/octet-stream";
        const r2Key = buildR2Key(prefix, filename);
        const now = Math.floor(Date.now() / 1000);

        // 上传到 R2
        await bucket.put(r2Key, buffer, {
            httpMetadata: { contentType },
            customMetadata: { checksum },
        });

        // 检查是否已存在
        const existing = await db
            .prepare(
                `SELECT id FROM template_assets WHERE asset_prefix = ? AND filename = ?`
            )
            .bind(prefix, filename)
            .first<{ id: number }>();

        if (existing) {
            await db
                .prepare(
                    `UPDATE template_assets
                     SET content = NULL, content_type = ?, size = ?, checksum = ?,
                         storage_type = 1, r2_key = ?, is_public = ?, alt_text = ?, updated_at = ?
                     WHERE id = ?`
                )
                .bind(
                    contentType,
                    buffer.byteLength,
                    checksum,
                    r2Key,
                    isPublic,
                    altText,
                    now,
                    existing.id
                )
                .run();

            const updated = await db
                .prepare(
                    `SELECT id, asset_prefix, filename, content_type, size, checksum,
                            storage_type, r2_key, is_public, alt_text, created_at, updated_at
                     FROM template_assets WHERE id = ?`
                )
                .bind(existing.id)
                .first<TemplateAssetListItem>();

            return c.json<HttpResponseJsonBody<TemplateAssetListItem>>({
                code: ErrorCode.SUCCESS,
                message: "资源更新成功",
                data: updated!,
            });
        }

        const result = await db
            .prepare(
                `INSERT INTO template_assets
                     (asset_prefix, filename, content_type, size, checksum,
                      storage_type, content, r2_key, is_public, alt_text, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, ?)`
            )
            .bind(
                prefix,
                filename,
                contentType,
                buffer.byteLength,
                checksum,
                r2Key,
                isPublic,
                altText,
                now,
                now
            )
            .run();

        const newAsset = await db
            .prepare(
                `SELECT id, asset_prefix, filename, content_type, size, checksum,
                        storage_type, r2_key, is_public, alt_text, created_at, updated_at
                 FROM template_assets WHERE id = ?`
            )
            .bind(result.meta.last_row_id)
            .first<TemplateAssetListItem>();

        return c.json<HttpResponseJsonBody<TemplateAssetListItem>>(
            { code: ErrorCode.SUCCESS, message: "资源上传成功", data: newAsset! },
            201
        );
    } catch (error) {
        console.error("上传资源到 R2 失败:", error);
        return c.json<HttpResponseJsonBody>(
            { code: ErrorCode.UNKNOWN_ERROR, message: "上传资源到 R2 失败" },
            500
        );
    }
});

/**
 * POST /upload/r2/multipart/create
 * 创建分片上传会话
 * Body JSON: { prefix, filename, content_type? }
 */
app.post("/upload/r2/multipart/create", async (c) => {
    try {
        const bucket = c.env.R2_BUCKET;

        if (!bucket) {
            return c.json<HttpResponseJsonBody>(
                { code: ErrorCode.UNKNOWN_ERROR, message: "R2 存储桶未配置" },
                500
            );
        }

        const body = await c.req.json<{
            prefix: string;
            filename: string;
            content_type?: string;
        }>();

        if (!body.prefix || !body.filename) {
            return c.json<HttpResponseJsonBody>(
                {
                    code: ErrorCode.DATA_INPUT_ERROR,
                    message: "prefix 和 filename 不能为空",
                },
                400
            );
        }

        const filename = body.filename.replace(/^\/+|\/+$/g, "");
        const r2Key = buildR2Key(body.prefix, filename);

        const multipartUpload = await bucket.createMultipartUpload(r2Key, {
            httpMetadata: {
                contentType:
                    body.content_type || "application/octet-stream",
            },
        });

        return c.json<
            HttpResponseJsonBody<{
                uploadId: string;
                r2Key: string;
            }>
        >({
            code: ErrorCode.SUCCESS,
            message: "分片上传会话已创建",
            data: {
                uploadId: multipartUpload.uploadId,
                r2Key: multipartUpload.key,
            },
        });
    } catch (error) {
        console.error("创建分片上传会话失败:", error);
        return c.json<HttpResponseJsonBody>(
            { code: ErrorCode.UNKNOWN_ERROR, message: "创建分片上传会话失败" },
            500
        );
    }
});

/**
 * POST /upload/r2/multipart/part
 * 上传单个分片
 * Query: r2Key, uploadId, partNumber
 * Body: 二进制分片数据（raw body）
 */
app.post("/upload/r2/multipart/part", async (c) => {
    try {
        const bucket = c.env.R2_BUCKET;

        if (!bucket) {
            return c.json<HttpResponseJsonBody>(
                { code: ErrorCode.UNKNOWN_ERROR, message: "R2 存储桶未配置" },
                500
            );
        }

        const r2Key = c.req.query("r2Key");
        const uploadId = c.req.query("uploadId");
        const partNumber = parseInt(c.req.query("partNumber") || "0");

        if (!r2Key || !uploadId || !partNumber) {
            return c.json<HttpResponseJsonBody>(
                {
                    code: ErrorCode.DATA_INPUT_ERROR,
                    message: "r2Key、uploadId、partNumber 不能为空",
                },
                400
            );
        }

        const multipartUpload = bucket.resumeMultipartUpload(r2Key, uploadId);
        const partBody = await c.req.arrayBuffer();
        const uploadedPart = await multipartUpload.uploadPart(
            partNumber,
            partBody
        );

        return c.json<
            HttpResponseJsonBody<{
                partNumber: number;
                etag: string;
            }>
        >({
            code: ErrorCode.SUCCESS,
            message: "分片上传成功",
            data: {
                partNumber: uploadedPart.partNumber,
                etag: uploadedPart.etag,
            },
        });
    } catch (error) {
        console.error("上传分片失败:", error);
        return c.json<HttpResponseJsonBody>(
            { code: ErrorCode.UNKNOWN_ERROR, message: "上传分片失败" },
            500
        );
    }
});

/**
 * POST /upload/r2/multipart/complete
 * 完成分片上传并写入数据库记录
 * Body JSON: { prefix, filename, r2Key, uploadId, parts: [{partNumber, etag}], size, is_public?, alt_text? }
 */
app.post("/upload/r2/multipart/complete", async (c) => {
    try {
        const db = c.env.shorturl;
        const bucket = c.env.R2_BUCKET;

        if (!bucket) {
            return c.json<HttpResponseJsonBody>(
                { code: ErrorCode.UNKNOWN_ERROR, message: "R2 存储桶未配置" },
                500
            );
        }

        const body = await c.req.json<{
            prefix: string;
            filename: string;
            r2Key: string;
            uploadId: string;
            parts: { partNumber: number; etag: string }[];
            size: number;
            content_type?: string;
            is_public?: number;
            alt_text?: string;
        }>();

        if (
            !body.prefix ||
            !body.filename ||
            !body.r2Key ||
            !body.uploadId ||
            !body.parts?.length
        ) {
            return c.json<HttpResponseJsonBody>(
                { code: ErrorCode.DATA_INPUT_ERROR, message: "参数不完整" },
                400
            );
        }

        const filename = body.filename.replace(/^\/+|\/+$/g, "");

        // 完成分片上传
        const multipartUpload = bucket.resumeMultipartUpload(
            body.r2Key,
            body.uploadId
        );
        const object = await multipartUpload.complete(body.parts);

        const contentType =
            body.content_type || "application/octet-stream";
        const now = Math.floor(Date.now() / 1000);
        const isPublic = body.is_public ?? 0;
        const altText = body.alt_text || null;

        // 写入/更新数据库记录
        const existing = await db
            .prepare(
                `SELECT id FROM template_assets WHERE asset_prefix = ? AND filename = ?`
            )
            .bind(body.prefix, filename)
            .first<{ id: number }>();

        if (existing) {
            await db
                .prepare(
                    `UPDATE template_assets
                     SET content = NULL, content_type = ?, size = ?, checksum = ?,
                         storage_type = 1, r2_key = ?, is_public = ?, alt_text = ?, updated_at = ?
                     WHERE id = ?`
                )
                .bind(
                    contentType,
                    body.size || object.size,
                    object.etag,
                    body.r2Key,
                    isPublic,
                    altText,
                    now,
                    existing.id
                )
                .run();

            const updated = await db
                .prepare(
                    `SELECT id, asset_prefix, filename, content_type, size, checksum,
                            storage_type, r2_key, is_public, alt_text, created_at, updated_at
                     FROM template_assets WHERE id = ?`
                )
                .bind(existing.id)
                .first<TemplateAssetListItem>();

            return c.json<HttpResponseJsonBody<TemplateAssetListItem>>({
                code: ErrorCode.SUCCESS,
                message: "分片上传完成，资源已更新",
                data: updated!,
            });
        }

        const result = await db
            .prepare(
                `INSERT INTO template_assets
                     (asset_prefix, filename, content_type, size, checksum,
                      storage_type, content, r2_key, is_public, alt_text, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, ?)`
            )
            .bind(
                body.prefix,
                filename,
                contentType,
                body.size || object.size,
                object.etag,
                body.r2Key,
                isPublic,
                altText,
                now,
                now
            )
            .run();

        const newAsset = await db
            .prepare(
                `SELECT id, asset_prefix, filename, content_type, size, checksum,
                        storage_type, r2_key, is_public, alt_text, created_at, updated_at
                 FROM template_assets WHERE id = ?`
            )
            .bind(result.meta.last_row_id)
            .first<TemplateAssetListItem>();

        return c.json<HttpResponseJsonBody<TemplateAssetListItem>>(
            {
                code: ErrorCode.SUCCESS,
                message: "分片上传完成",
                data: newAsset!,
            },
            201
        );
    } catch (error) {
        console.error("完成分片上传失败:", error);
        return c.json<HttpResponseJsonBody>(
            { code: ErrorCode.UNKNOWN_ERROR, message: "完成分片上传失败" },
            500
        );
    }
});

/**
 * POST /upload/r2/multipart/abort
 * 取消分片上传
 * Body JSON: { r2Key, uploadId }
 */
app.post("/upload/r2/multipart/abort", async (c) => {
    try {
        const bucket = c.env.R2_BUCKET;

        if (!bucket) {
            return c.json<HttpResponseJsonBody>(
                { code: ErrorCode.UNKNOWN_ERROR, message: "R2 存储桶未配置" },
                500
            );
        }

        const body = await c.req.json<{ r2Key: string; uploadId: string }>();

        if (!body.r2Key || !body.uploadId) {
            return c.json<HttpResponseJsonBody>(
                {
                    code: ErrorCode.DATA_INPUT_ERROR,
                    message: "r2Key 和 uploadId 不能为空",
                },
                400
            );
        }

        const multipartUpload = bucket.resumeMultipartUpload(
            body.r2Key,
            body.uploadId
        );
        await multipartUpload.abort();

        return c.json<HttpResponseJsonBody>({
            code: ErrorCode.SUCCESS,
            message: "分片上传已取消",
        });
    } catch (error) {
        console.error("取消分片上传失败:", error);
        return c.json<HttpResponseJsonBody>(
            { code: ErrorCode.UNKNOWN_ERROR, message: "取消分片上传失败" },
            500
        );
    }
});

/**
 * PUT /update/:id
 * 更新资源元信息（不含文件内容）
 * Body JSON: { filename?, is_public?, alt_text?, content_type? }
 */
app.put("/update/:id", async (c) => {
    try {
        const db = c.env.shorturl;
        const id = parseInt(c.req.param("id"));

        if (isNaN(id)) {
            return c.json<HttpResponseJsonBody>(
                { code: ErrorCode.DATA_INPUT_ERROR, message: "无效的资源 ID" },
                400
            );
        }

        const existing = await db
            .prepare(`SELECT * FROM template_assets WHERE id = ?`)
            .bind(id)
            .first<TemplateAsset>();

        if (!existing) {
            return c.json<HttpResponseJsonBody>(
                { code: ErrorCode.DATA_INPUT_ERROR, message: "资源不存在" },
                404
            );
        }

        const body = await c.req.json<{
            filename?: string;
            is_public?: number;
            alt_text?: string | null;
            content_type?: string;
        }>();

        const now = Math.floor(Date.now() / 1000);
        const updates: string[] = [];
        const params: DBParam[] = [];

        if (body.filename !== undefined) {
            const newFilename = body.filename.replace(/^\/+|\/+$/g, "");
            // 检查新文件名是否与同 prefix 下其他文件冲突
            const dup = await db
                .prepare(
                    `SELECT id FROM template_assets WHERE asset_prefix = ? AND filename = ? AND id != ?`
                )
                .bind(existing.asset_prefix, newFilename, id)
                .first<{ id: number }>();

            if (dup) {
                return c.json<HttpResponseJsonBody>(
                    {
                        code: ErrorCode.DATA_INPUT_ERROR,
                        message: "同一 prefix 下已存在同名文件",
                    },
                    409
                );
            }

            updates.push("filename = ?");
            params.push(newFilename);

            // 如果是 R2 存储，需要同步更新 r2_key
            if (existing.storage_type === 1 && existing.r2_key) {
                const newR2Key = buildR2Key(existing.asset_prefix, newFilename);
                updates.push("r2_key = ?");
                params.push(newR2Key);
                // 注意：R2 中的对象需要复制+删除来"重命名"，这里在后台处理
                // 由于 R2 不支持 rename，实际做法是 copy + delete
                const bucket = c.env.R2_BUCKET;
                if (bucket) {
                    const obj = await bucket.get(existing.r2_key);
                    if (obj) {
                        await bucket.put(newR2Key, obj.body, {
                            httpMetadata: {
                                contentType:
                                    existing.content_type ||
                                    "application/octet-stream",
                            },
                        });
                        await bucket.delete(existing.r2_key);
                    }
                }
            }
        }

        if (body.is_public !== undefined) {
            updates.push("is_public = ?");
            params.push(body.is_public);
        }
        if (body.alt_text !== undefined) {
            updates.push("alt_text = ?");
            params.push(body.alt_text);
        }
        if (body.content_type !== undefined) {
            updates.push("content_type = ?");
            params.push(body.content_type);
        }

        if (updates.length === 0) {
            return c.json<HttpResponseJsonBody>(
                {
                    code: ErrorCode.DATA_INPUT_ERROR,
                    message: "没有需要更新的字段",
                },
                400
            );
        }

        updates.push("updated_at = ?");
        params.push(now);
        params.push(id);

        await db
            .prepare(
                `UPDATE template_assets SET ${updates.join(", ")} WHERE id = ?`
            )
            .bind(...params)
            .run();

        const updated = await db
            .prepare(
                `SELECT id, asset_prefix, filename, content_type, size, checksum,
                        storage_type, r2_key, is_public, alt_text, created_at, updated_at
                 FROM template_assets WHERE id = ?`
            )
            .bind(id)
            .first<TemplateAssetListItem>();

        return c.json<HttpResponseJsonBody<TemplateAssetListItem>>({
            code: ErrorCode.SUCCESS,
            message: "资源更新成功",
            data: updated!,
        });
    } catch (error) {
        console.error("更新资源失败:", error);
        return c.json<HttpResponseJsonBody>(
            { code: ErrorCode.UNKNOWN_ERROR, message: "更新资源失败" },
            500
        );
    }
});

/**
 * DELETE /delete/:id
 * 删除单个资源（同时删除 R2 文件）
 */
app.delete("/delete/:id", async (c) => {
    try {
        const db = c.env.shorturl;
        const id = parseInt(c.req.param("id"));

        if (isNaN(id)) {
            return c.json<HttpResponseJsonBody>(
                { code: ErrorCode.DATA_INPUT_ERROR, message: "无效的资源 ID" },
                400
            );
        }

        const existing = await db
            .prepare(
                `SELECT id, storage_type, r2_key FROM template_assets WHERE id = ?`
            )
            .bind(id)
            .first<{ id: number; storage_type: number; r2_key: string | null }>();

        if (!existing) {
            return c.json<HttpResponseJsonBody>(
                { code: ErrorCode.DATA_INPUT_ERROR, message: "资源不存在" },
                404
            );
        }

        // 如果是 R2 存储，先删除 R2 对象
        if (existing.storage_type === 1 && existing.r2_key && c.env.R2_BUCKET) {
            await c.env.R2_BUCKET.delete(existing.r2_key);
        }

        await db
            .prepare(`DELETE FROM template_assets WHERE id = ?`)
            .bind(id)
            .run();

        return c.json<HttpResponseJsonBody>({
            code: ErrorCode.SUCCESS,
            message: "资源删除成功",
        });
    } catch (error) {
        console.error("删除资源失败:", error);
        return c.json<HttpResponseJsonBody>(
            { code: ErrorCode.UNKNOWN_ERROR, message: "删除资源失败" },
            500
        );
    }
});

/**
 * DELETE /delete-batch
 * 批量删除资源
 * Body JSON: { ids: number[] }
 */
app.delete("/delete-batch", async (c) => {
    try {
        const db = c.env.shorturl;
        const body = await c.req.json<{ ids: number[] }>();

        if (!body.ids?.length) {
            return c.json<HttpResponseJsonBody>(
                { code: ErrorCode.DATA_INPUT_ERROR, message: "ids 不能为空" },
                400
            );
        }

        // 查询所有要删除的资源
        const placeholders = body.ids.map(() => "?").join(",");
        const assets = await db
            .prepare(
                `SELECT id, storage_type, r2_key FROM template_assets WHERE id IN (${placeholders})`
            )
            .bind(...body.ids)
            .all<{ id: number; storage_type: number; r2_key: string | null }>();

        // 删除 R2 对象
        const r2Keys = assets.results
            .filter((a) => a.storage_type === 1 && a.r2_key)
            .map((a) => a.r2_key!);

        if (r2Keys.length > 0 && c.env.R2_BUCKET) {
            await c.env.R2_BUCKET.delete(r2Keys);
        }

        // 删除数据库记录
        await db
            .prepare(
                `DELETE FROM template_assets WHERE id IN (${placeholders})`
            )
            .bind(...body.ids)
            .run();

        return c.json<HttpResponseJsonBody>({
            code: ErrorCode.SUCCESS,
            message: `成功删除 ${assets.results.length} 个资源`,
        });
    } catch (error) {
        console.error("批量删除资源失败:", error);
        return c.json<HttpResponseJsonBody>(
            { code: ErrorCode.UNKNOWN_ERROR, message: "批量删除资源失败" },
            500
        );
    }
});

/**
 * DELETE /delete-by-prefix
 * 删除指定 prefix 下的所有资源
 * Body JSON: { prefix: string }
 */
/**
 * GET /prefixes
 * 获取所有不重复的 asset_prefix 列表
 */
app.get("/prefixes", async (c) => {
    try {
        const db = c.env.shorturl;

        const result = await db
            .prepare(
                `SELECT asset_prefix, COUNT(*) as file_count, SUM(size) as total_size
                 FROM template_assets
                 GROUP BY asset_prefix
                 ORDER BY asset_prefix ASC`
            )
            .all<{ asset_prefix: string; file_count: number; total_size: number | null }>();

        return c.json<HttpResponseJsonBody<{ prefixes: typeof result.results }>>({
            code: ErrorCode.SUCCESS,
            message: "查询成功",
            data: {
                prefixes: result.results,
            },
        });
    } catch (error) {
        console.error("查询 prefix 列表失败:", error);
        return c.json<HttpResponseJsonBody>(
            { code: ErrorCode.UNKNOWN_ERROR, message: "查询 prefix 列表失败" },
            500
        );
    }
});

app.delete("/delete-by-prefix", async (c) => {
    try {
        const db = c.env.shorturl;
        const body = await c.req.json<{ prefix: string }>();

        if (!body.prefix) {
            return c.json<HttpResponseJsonBody>(
                { code: ErrorCode.DATA_INPUT_ERROR, message: "prefix 不能为空" },
                400
            );
        }

        // 查询所有要删除的 R2 资源
        const assets = await db
            .prepare(
                `SELECT id, storage_type, r2_key FROM template_assets
                 WHERE asset_prefix = ? AND storage_type = 1 AND r2_key IS NOT NULL`
            )
            .bind(body.prefix)
            .all<{ id: number; storage_type: number; r2_key: string }>();

        // 批量删除 R2 对象
        const r2Keys = assets.results.map((a) => a.r2_key);
        if (r2Keys.length > 0 && c.env.R2_BUCKET) {
            await c.env.R2_BUCKET.delete(r2Keys);
        }

        // 删除所有记录
        await db
            .prepare(`DELETE FROM template_assets WHERE asset_prefix = ?`)
            .bind(body.prefix)
            .run();

        return c.json<HttpResponseJsonBody>({
            code: ErrorCode.SUCCESS,
            message: `成功删除 prefix "${body.prefix}" 下的所有资源`,
        });
    } catch (error) {
        console.error("删除 prefix 资源失败:", error);
        return c.json<HttpResponseJsonBody>(
            { code: ErrorCode.UNKNOWN_ERROR, message: "删除 prefix 资源失败" },
            500
        );
    }
});

export default app;