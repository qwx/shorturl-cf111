import { Hono } from "hono";
import { ErrorCode, HttpResponseJsonBody, Variables } from "../util";

// ============ 类型定义 ============

interface RedirectTemplate {
    id: number;
    name: string;
    content_type: number;
    html_content: string | null;
    main_file: string | null;
    asset_prefix: string | null;
    is_active: number;
    type: number | null;
    created_by: number | null;
    created_at: number;
    updated_at: number | null;
}

/** 列表项：不返回 html_content（可能很大） */
type RedirectTemplateListItem = Omit<RedirectTemplate, "html_content">;

/** 详情：包含所有字段 */
type RedirectTemplateDetail = RedirectTemplate;

interface TemplateListResponse {
    results: RedirectTemplateListItem[];
    pagination: {
        page: number;
        pageSize: number;
        total: number;
        totalPages: number;
    };
}

interface CreateTemplateRequest {
    name: string;
    content_type?: number;       // 0=HTML content, 1=文件，默认 0
    html_content?: string;       // content_type=0 时使用
    main_file?: string;          // content_type=1 时使用
    asset_prefix?: string;       // 资源前缀，不提供则自动生成
    is_active?: number;          // 默认 1
    type?: number;               // 0=普通模板，1=密码页，2=错误页，3=未找到页
}

interface UpdateTemplateRequest {
    name?: string;
    content_type?: number;
    html_content?: string | null;
    main_file?: string | null;
    asset_prefix?: string | null;
    is_active?: number;
    type?: number | null;
}

type DBParam = string | number | null;

const app = new Hono<{ Variables: Variables; Bindings: Env }>();

// ============ 辅助函数 ============

/** 生成随机前缀（8 位十六进制） */
function generateAssetPrefix(): string {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ============ 接口 ============

/**
 * GET /list
 * 获取模板列表（分页）
 * query: page, pageSize, name (模糊搜索), type, is_active
 */
app.get("/list", async (c) => {
    try {
        const db = c.env.shorturl;

        const page = parseInt(c.req.query("page") || "1");
        const pageSize = parseInt(c.req.query("pageSize") || "10");
        const offset = (page - 1) * pageSize;
        const nameSearch = c.req.query("name") || "";
        const typeFilter = c.req.query("type");
        const activeFilter = c.req.query("is_active");

        let countSql = `SELECT COUNT(*) as total FROM redirect_templates WHERE 1=1`;
        let dataSql = `SELECT id, name, content_type, main_file, asset_prefix, is_active, type, created_by, created_at, updated_at
                        FROM redirect_templates WHERE 1=1`;
        const params: DBParam[] = [];

        if (nameSearch) {
            countSql += ` AND name LIKE ?`;
            dataSql += ` AND name LIKE ?`;
            params.push(`%${nameSearch}%`);
        }

        if (typeFilter !== undefined && typeFilter !== null && typeFilter !== "") {
            countSql += ` AND type = ?`;
            dataSql += ` AND type = ?`;
            params.push(parseInt(typeFilter));
        }

        if (activeFilter !== undefined && activeFilter !== null && activeFilter !== "") {
            countSql += ` AND is_active = ?`;
            dataSql += ` AND is_active = ?`;
            params.push(parseInt(activeFilter));
        }

        dataSql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;

        const countResult = await db
            .prepare(countSql)
            .bind(...params)
            .first<{ total: number }>();
        const total = countResult?.total || 0;

        const result = await db
            .prepare(dataSql)
            .bind(...params, pageSize, offset)
            .all();

        return c.json<HttpResponseJsonBody<TemplateListResponse>>({
            code: ErrorCode.SUCCESS,
            message: "查询成功",
            data: {
                results: result.results as unknown as RedirectTemplateListItem[],
                pagination: {
                    page,
                    pageSize,
                    total,
                    totalPages: Math.ceil(total / pageSize),
                },
            },
        });
    } catch (error) {
        console.error("查询模板列表失败:", error);
        return c.json<HttpResponseJsonBody>(
            { code: ErrorCode.UNKNOWN_ERROR, message: "查询模板列表失败" },
            500
        );
    }
});

/**
 * GET /detail/:id
 * 获取单个模板详情（包含 html_content）
 */
app.get("/detail/:id", async (c) => {
    try {
        const db = c.env.shorturl;
        const id = parseInt(c.req.param("id"));

        if (isNaN(id)) {
            return c.json<HttpResponseJsonBody>(
                { code: ErrorCode.DATA_INPUT_ERROR, message: "无效的模板 ID" },
                400
            );
        }

        const template = await db
            .prepare(
                `SELECT id, name, content_type, html_content, main_file, asset_prefix,
                        is_active, type, created_by, created_at, updated_at
                 FROM redirect_templates WHERE id = ?`
            )
            .bind(id)
            .first<RedirectTemplateDetail>();

        if (!template) {
            return c.json<HttpResponseJsonBody>(
                { code: ErrorCode.DATA_INPUT_ERROR, message: "模板不存在" },
                404
            );
        }

        return c.json<HttpResponseJsonBody<RedirectTemplateDetail>>({
            code: ErrorCode.SUCCESS,
            message: "查询成功",
            data: template,
        });
    } catch (error) {
        console.error("查询模板详情失败:", error);
        return c.json<HttpResponseJsonBody>(
            { code: ErrorCode.UNKNOWN_ERROR, message: "查询模板详情失败" },
            500
        );
    }
});

/**
 * POST /create
 * 创建模板
 */
app.post("/create", async (c) => {
    try {
        const db = c.env.shorturl;
        const body = await c.req.json<CreateTemplateRequest>();
        const currentUser = c.get("currentUser");

        // 参数验证
        if (!body.name || !body.name.trim()) {
            return c.json<HttpResponseJsonBody>(
                { code: ErrorCode.DATA_INPUT_ERROR, message: "模板名称不能为空" },
                400
            );
        }

        const contentType = body.content_type ?? 0;

        if (contentType === 0 && !body.html_content) {
            return c.json<HttpResponseJsonBody>(
                { code: ErrorCode.DATA_INPUT_ERROR, message: "HTML 内容不能为空" },
                400
            );
        }

        if (contentType === 1 && !body.main_file) {
            return c.json<HttpResponseJsonBody>(
                { code: ErrorCode.DATA_INPUT_ERROR, message: "主文件路径不能为空" },
                400
            );
        }

        const now = Math.floor(Date.now() / 1000);
        // 如果是文件模式且没有提供 asset_prefix，自动生成
        let assetPrefix = body.asset_prefix || null;
        if (contentType === 1 && !assetPrefix) {
            assetPrefix = generateAssetPrefix();
        }

        const result = await db
            .prepare(
                `INSERT INTO redirect_templates
                     (name, content_type, html_content, main_file, asset_prefix,
                      is_active, type, created_by, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(
                body.name.trim(),
                contentType,
                contentType === 0 ? (body.html_content || null) : null,
                contentType === 1 ? (body.main_file || null) : null,
                assetPrefix,
                body.is_active ?? 1,
                body.type ?? null,
                currentUser.id,
                now,
                now
            )
            .run();

        const newTemplate = await db
            .prepare(
                `SELECT id, name, content_type, html_content, main_file, asset_prefix,
                        is_active, type, created_by, created_at, updated_at
                 FROM redirect_templates WHERE id = ?`
            )
            .bind(result.meta.last_row_id)
            .first<RedirectTemplateDetail>();

        return c.json<HttpResponseJsonBody<RedirectTemplateDetail>>(
            { code: ErrorCode.SUCCESS, message: "模板创建成功", data: newTemplate! },
            201
        );
    } catch (error) {
        console.error("创建模板失败:", error);
        return c.json<HttpResponseJsonBody>(
            { code: ErrorCode.UNKNOWN_ERROR, message: "创建模板失败" },
            500
        );
    }
});

/**
 * PUT /update/:id
 * 更新模板
 */
app.put("/update/:id", async (c) => {
    try {
        const db = c.env.shorturl;
        const id = parseInt(c.req.param("id"));
        const body = await c.req.json<UpdateTemplateRequest>();

        if (isNaN(id)) {
            return c.json<HttpResponseJsonBody>(
                { code: ErrorCode.DATA_INPUT_ERROR, message: "无效的模板 ID" },
                400
            );
        }

        // 检查模板是否存在
        const existing = await db
            .prepare(`SELECT * FROM redirect_templates WHERE id = ?`)
            .bind(id)
            .first<RedirectTemplate>();

        if (!existing) {
            return c.json<HttpResponseJsonBody>(
                { code: ErrorCode.DATA_INPUT_ERROR, message: "模板不存在" },
                404
            );
        }

        const now = Math.floor(Date.now() / 1000);
        const updates: string[] = [];
        const params: DBParam[] = [];

        if (body.name !== undefined) {
            if (!body.name || !body.name.trim()) {
                return c.json<HttpResponseJsonBody>(
                    { code: ErrorCode.DATA_INPUT_ERROR, message: "模板名称不能为空" },
                    400
                );
            }
            updates.push("name = ?");
            params.push(body.name.trim());
        }

        if (body.content_type !== undefined) {
            updates.push("content_type = ?");
            params.push(body.content_type);
        }

        if (body.html_content !== undefined) {
            updates.push("html_content = ?");
            params.push(body.html_content);
        }

        if (body.main_file !== undefined) {
            updates.push("main_file = ?");
            params.push(body.main_file);
        }

        if (body.asset_prefix !== undefined) {
            updates.push("asset_prefix = ?");
            params.push(body.asset_prefix);
        }

        if (body.is_active !== undefined) {
            updates.push("is_active = ?");
            params.push(body.is_active);
        }

        if (body.type !== undefined) {
            updates.push("type = ?");
            params.push(body.type);
        }

        if (updates.length === 0) {
            return c.json<HttpResponseJsonBody>(
                { code: ErrorCode.DATA_INPUT_ERROR, message: "没有需要更新的字段" },
                400
            );
        }

        updates.push("updated_at = ?");
        params.push(now);
        params.push(id);

        await db
            .prepare(
                `UPDATE redirect_templates SET ${updates.join(", ")} WHERE id = ?`
            )
            .bind(...params)
            .run();

        const updated = await db
            .prepare(
                `SELECT id, name, content_type, html_content, main_file, asset_prefix,
                        is_active, type, created_by, created_at, updated_at
                 FROM redirect_templates WHERE id = ?`
            )
            .bind(id)
            .first<RedirectTemplateDetail>();

        return c.json<HttpResponseJsonBody<RedirectTemplateDetail>>({
            code: ErrorCode.SUCCESS,
            message: "模板更新成功",
            data: updated!,
        });
    } catch (error) {
        console.error("更新模板失败:", error);
        return c.json<HttpResponseJsonBody>(
            { code: ErrorCode.UNKNOWN_ERROR, message: "更新模板失败" },
            500
        );
    }
});

/**
 * DELETE /delete/:id
 * 删除模板
 * 会检查是否有域名或短链接在引用此模板
 */
app.delete("/delete/:id", async (c) => {
    try {
        const db = c.env.shorturl;
        const id = parseInt(c.req.param("id"));

        if (isNaN(id)) {
            return c.json<HttpResponseJsonBody>(
                { code: ErrorCode.DATA_INPUT_ERROR, message: "无效的模板 ID" },
                400
            );
        }

        // 检查模板是否存在
        const existing = await db
            .prepare(`SELECT * FROM redirect_templates WHERE id = ?`)
            .bind(id)
            .first<RedirectTemplate>();

        if (!existing) {
            return c.json<HttpResponseJsonBody>(
                { code: ErrorCode.DATA_INPUT_ERROR, message: "模板不存在" },
                404
            );
        }

        // 检查是否被域名引用
        const domainRef = await db
            .prepare(
                `SELECT COUNT(*) as count FROM domains
                 WHERE error_template_id = ? OR password_template_id = ? OR interstitial_template_id = ?`
            )
            .bind(id, id, id)
            .first<{ count: number }>();

        if (domainRef && domainRef.count > 0) {
            return c.json<HttpResponseJsonBody>(
                {
                    code: ErrorCode.DATA_INPUT_ERROR,
                    message: `该模板被 ${domainRef.count} 个域名引用，无法删除`,
                },
                400
            );
        }

        // 检查是否被短链接引用
        const linkRef = await db
            .prepare(
                `SELECT COUNT(*) as count FROM short_links
                 WHERE (template_id = ? OR error_template_id = ? OR password_template_id = ?)
                   AND deleted_at IS NULL`
            )
            .bind(id, id, id)
            .first<{ count: number }>();

        if (linkRef && linkRef.count > 0) {
            return c.json<HttpResponseJsonBody>(
                {
                    code: ErrorCode.DATA_INPUT_ERROR,
                    message: `该模板被 ${linkRef.count} 个短链接引用，无法删除`,
                },
                400
            );
        }

        // 如果模板有 asset_prefix，检查是否有其他模板也在使用同一前缀
        if (existing.asset_prefix) {
            const otherTemplatesUsingPrefix = await db
                .prepare(
                    `SELECT COUNT(*) as count FROM redirect_templates
                     WHERE asset_prefix = ? AND id != ?`
                )
                .bind(existing.asset_prefix, id)
                .first<{ count: number }>();

            // 如果没有其他模板使用此前缀，清理关联的资源文件
            if (!otherTemplatesUsingPrefix || otherTemplatesUsingPrefix.count === 0) {
                // 获取 R2 存储的资源，需要从 R2 删除
                const r2Assets = await db
                    .prepare(
                        `SELECT r2_key FROM template_assets
                         WHERE asset_prefix = ? AND storage_type = 1 AND r2_key IS NOT NULL`
                    )
                    .bind(existing.asset_prefix)
                    .all();

                // 删除 R2 文件
                const bucket = c.env.R2_BUCKET;
                if (bucket && r2Assets.results.length > 0) {
                    const keys = r2Assets.results
                        .map((r) => (r as unknown as { r2_key: string }).r2_key)
                        .filter(Boolean);
                    if (keys.length > 0) {
                        await bucket.delete(keys);
                    }
                }

                // 删除数据库中的资源记录
                await db
                    .prepare(`DELETE FROM template_assets WHERE asset_prefix = ?`)
                    .bind(existing.asset_prefix)
                    .run();
            }
        }

        // 删除模板
        await db
            .prepare(`DELETE FROM redirect_templates WHERE id = ?`)
            .bind(id)
            .run();

        return c.json<HttpResponseJsonBody>({
            code: ErrorCode.SUCCESS,
            message: "模板删除成功",
        });
    } catch (error) {
        console.error("删除模板失败:", error);
        return c.json<HttpResponseJsonBody>(
            { code: ErrorCode.UNKNOWN_ERROR, message: "删除模板失败" },
            500
        );
    }
});

/**
 * POST /toggle-active/:id
 * 切换模板的启用/禁用状态
 */
app.post("/toggle-active/:id", async (c) => {
    try {
        const db = c.env.shorturl;
        const id = parseInt(c.req.param("id"));

        if (isNaN(id)) {
            return c.json<HttpResponseJsonBody>(
                { code: ErrorCode.DATA_INPUT_ERROR, message: "无效的模板 ID" },
                400
            );
        }

        const existing = await db
            .prepare(`SELECT id, is_active FROM redirect_templates WHERE id = ?`)
            .bind(id)
            .first<{ id: number; is_active: number }>();

        if (!existing) {
            return c.json<HttpResponseJsonBody>(
                { code: ErrorCode.DATA_INPUT_ERROR, message: "模板不存在" },
                404
            );
        }

        const now = Math.floor(Date.now() / 1000);
        const newActive = existing.is_active === 1 ? 0 : 1;

        await db
            .prepare(
                `UPDATE redirect_templates SET is_active = ?, updated_at = ? WHERE id = ?`
            )
            .bind(newActive, now, id)
            .run();

        return c.json<HttpResponseJsonBody<{ is_active: number }>>({
            code: ErrorCode.SUCCESS,
            message: newActive === 1 ? "模板已启用" : "模板已禁用",
            data: { is_active: newActive },
        });
    } catch (error) {
        console.error("切换模板状态失败:", error);
        return c.json<HttpResponseJsonBody>(
            { code: ErrorCode.UNKNOWN_ERROR, message: "切换模板状态失败" },
            500
        );
    }
});

/**
 * GET /select-options
 * 获取模板下拉选项列表（用于域名/短链接关联模板时的选择器）
 * query: type (可选，按模板类型过滤)
 */
app.get("/select-options", async (c) => {
    try {
        const db = c.env.shorturl;
        const typeFilter = c.req.query("type");

        let sql = `SELECT id, name, type, content_type, is_active FROM redirect_templates WHERE is_active = 1`;
        const params: DBParam[] = [];

        if (typeFilter !== undefined && typeFilter !== null && typeFilter !== "") {
            sql += ` AND type = ?`;
            params.push(parseInt(typeFilter));
        }

        sql += ` ORDER BY name ASC`;

        const result = await db.prepare(sql).bind(...params).all();

        return c.json<
            HttpResponseJsonBody<
                { id: number; name: string; type: number | null; content_type: number; is_active: number }[]
            >
        >({
            code: ErrorCode.SUCCESS,
            message: "查询成功",
            data: result.results as unknown as {
                id: number;
                name: string;
                type: number | null;
                content_type: number;
                is_active: number;
            }[],
        });
    } catch (error) {
        console.error("查询模板选项失败:", error);
        return c.json<HttpResponseJsonBody>(
            { code: ErrorCode.UNKNOWN_ERROR, message: "查询模板选项失败" },
            500
        );
    }
});

export default app;