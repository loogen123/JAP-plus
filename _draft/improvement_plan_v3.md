# JAP Plus 文件生成流程改进计划 v3

## 一、问题全景分析

### 1.1 当前工作流状态

```
需求文档 (03_final_requirement_fused.md)
         │
         ▼
┌─────────────────────────────────────────────────────────────────┐
│                    文件生成流程 (filewise模式)                    │
├─────────────────────────────────────────────────────────────────┤
│  文件01: 产品功能脑图与用例.md     ✅ APPROVED (用户已确认)       │
│  文件02: 领域模型与物理表结构.md   ❌ FAILED (重试2次失败)       │
│  文件03: 核心业务状态机.md         ⏳ PENDING                    │
│  文件04: RESTful API契约.yaml     ⏳ PENDING                    │
│  文件R1: 建模一致性审查.md         ⏳ PENDING                    │
│  文件05: 行为驱动验收测试.md       ⏳ PENDING                    │
│  文件06: UI原型与交互草图.html     ⏳ PENDING                    │
│  文件07: API调试集合.json          ⏳ PENDING                    │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 核心问题诊断

#### 问题一：文件02生成失败的技术原因

从错误日志分析：
```
Function "extract" arguments:
{"02_领域模型与物理表结构.md": "# 用户登录注册系统 - 领域模型与物理表结构..."}
```

**发现**：LLM成功生成了详细内容（包含完整ER图、10+张表结构），但结构化输出解析失败。

**根本原因**：
1. 输出内容过长，超过function calling的输出限制
2. JSON中包含特殊字符（Mermaid图中的引号、中文等），导致解析失败
3. 重试机制使用相同策略，无法解决根本问题

#### 问题二：文件01内容质量不足

**当前文件01的问题**：生成的是"功能规格书"，不是"实现规格书"

| 内容类型 | 当前状态 | 编程智能体需要的信息 |
|---------|---------|---------------------|
| 登录功能描述 | "用户名+密码登录" | `POST /api/v1/auth/login`，请求体 `{username, password}`，返回 `{token, expiresIn, user}` |
| 验证码描述 | "系统展示图形验证码" | 验证码生成算法、Redis key格式 `captcha:{sessionId}`、有效期5分钟、格式6位数字 |
| 密码校验描述 | "系统校验复杂度" | 正则表达式 `^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$` |
| 会话管理描述 | "存储: Redis" | Key格式 `session:{userId}:{deviceId}`，TTL 7天，刷新策略，并发处理 |
| 加密存储描述 | "国密/PBKDF2/AES-256" | 具体算法选择、迭代次数、盐值长度 |

**结论**：当前文件缺少"实现细节"，智能体无法直接编码。

---

## 二、目标文件规格定义

### 2.1 编程智能体需要什么？

编程智能体要完成项目，需要以下信息：

| 信息类型 | 说明 | 来源文件 |
|---------|------|---------|
| **API端点定义** | 每个接口的URL、方法、请求体、响应体 | 文件04 |
| **数据结构定义** | 每个表的字段、类型、约束、索引 | 文件02 |
| **业务逻辑定义** | 状态转换、验证规则、计算逻辑 | 文件03 |
| **测试用例定义** | 验收标准、边界条件、异常处理 | 文件05 |
| **UI交互定义** | 页面结构、表单字段、交互逻辑 | 文件06 |

### 2.2 每个文件应该包含的内容

#### 文件01：产品功能脑图与用例.md

**当前问题**：只有业务描述，缺少实现规格

**应该包含**：
```markdown
# 产品功能脑图与用例

## 1. 功能架构脑图 (Mermaid)
[保留当前的Mermaid图]

## 2. 用例实现规格

### UC-01: 用户注册

#### 2.1 API调用序列
| 步骤 | API端点 | 方法 | 请求体 | 响应体 |
|-----|---------|-----|--------|--------|
| 1. 获取图形验证码 | /api/v1/captcha | GET | - | `{captchaId, captchaImage}` |
| 2. 验证用户名唯一性 | /api/v1/users/check-username | POST | `{username}` | `{available: boolean}` |
| 3. 发送验证码 | /api/v1/sms/send | POST | `{phone, captchaId, captchaCode}` | `{success: boolean}` |
| 4. 注册 | /api/v1/auth/register | POST | `{username, phone, email, password, smsCode}` | `{userId, token}` |

#### 2.2 数据验证规则
| 字段 | 规则 | 错误提示 |
|-----|------|---------|
| username | 4-20字符，字母开头，允许字母数字下划线 | "用户名格式不正确" |
| phone | 11位手机号，正则 `^1[3-9]\d{9}$` | "手机号格式不正确" |
| password | 8-32字符，包含大小写字母、数字、特殊字符 | "密码强度不足" |

#### 2.3 业务规则
- 用户名全局唯一
- 手机号全局唯一
- 邮箱全局唯一
- 验证码5分钟内有效
- 同一手机号60秒内只能发送一次验证码

#### 2.4 错误码定义
| 错误码 | 说明 | HTTP状态码 |
|-------|------|-----------|
| USERNAME_EXISTS | 用户名已存在 | 400 |
| PHONE_EXISTS | 手机号已注册 | 400 |
| INVALID_CAPTCHA | 验证码错误 | 400 |
| SMS_CODE_EXPIRED | 短信验证码已过期 | 400 |
```

#### 文件02：领域模型与物理表结构.md

**应该包含**：
```markdown
# 领域模型与物理表结构

## 1. 领域模型图 (Mermaid ER图)

## 2. 实体定义

### User (用户聚合根)

#### 2.1 字段定义
| 字段名 | 类型 | 约束 | 默认值 | 说明 |
|-------|------|------|-------|------|
| id | BIGINT | PK, AUTO_INCREMENT | - | 主键 |
| username | VARCHAR(50) | UNIQUE, NOT NULL | - | 用户名 |
| phone | VARCHAR(20) | UNIQUE, NOT NULL | - | 手机号 |
| email | VARCHAR(100) | UNIQUE, NOT NULL | - | 邮箱 |
| password_hash | VARCHAR(255) | NOT NULL | - | 密码哈希 |
| salt | VARCHAR(64) | NOT NULL | - | 盐值 |
| status | TINYINT | NOT NULL | 1 | 状态: 1正常 2锁定 3禁用 4注销 |
| created_at | DATETIME | NOT NULL | CURRENT_TIMESTAMP | 创建时间 |
| updated_at | DATETIME | NOT NULL | CURRENT_TIMESTAMP ON UPDATE | 更新时间 |
| last_login_at | DATETIME | NULL | - | 最后登录时间 |
| failed_login_attempts | INT | NOT NULL | 0 | 连续登录失败次数 |
| locked_until | DATETIME | NULL | - | 锁定到期时间 |

#### 2.2 索引定义
| 索引名 | 类型 | 字段 |
|-------|------|------|
| uk_username | UNIQUE | username |
| uk_phone | UNIQUE | phone |
| uk_email | UNIQUE | email |
| idx_status | INDEX | status |
| idx_created_at | INDEX | created_at |

#### 2.3 业务约束
- 密码使用PBKDF2算法加密，迭代次数10000次
- 连续登录失败5次，账户锁定30分钟
- 账户注销后保留30天数据

## 3. 完整DDL语句

```sql
CREATE TABLE users (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    username VARCHAR(50) NOT NULL,
    phone VARCHAR(20) NOT NULL,
    email VARCHAR(100) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    salt VARCHAR(64) NOT NULL,
    status TINYINT NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    last_login_at DATETIME NULL,
    failed_login_attempts INT NOT NULL DEFAULT 0,
    locked_until DATETIME NULL,
    UNIQUE KEY uk_username (username),
    UNIQUE KEY uk_phone (phone),
    UNIQUE KEY uk_email (email),
    INDEX idx_status (status),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```
```

#### 文件04：RESTful API契约.yaml

**应该包含**：完整的OpenAPI 3.0规范，每个端点都有详细的请求/响应定义

```yaml
openapi: 3.0.3
info:
  title: 用户登录注册系统 API
  version: 1.0.0

paths:
  /api/v1/auth/register:
    post:
      summary: 用户注册
      tags: [认证]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/RegisterRequest'
            example:
              username: "testuser"
              phone: "13800138000"
              email: "test@example.com"
              password: "Password123!"
              smsCode: "123456"
              captchaId: "cap_abc123"
              captchaCode: "654321"
      responses:
        '201':
          description: 注册成功
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/RegisterResponse'
        '400':
          description: 请求参数错误
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              examples:
                username_exists:
                  value:
                    code: "USERNAME_EXISTS"
                    message: "用户名已存在"
                    timestamp: "2026-04-12T10:00:00Z"

components:
  schemas:
    RegisterRequest:
      type: object
      required: [username, phone, email, password, smsCode]
      properties:
        username:
          type: string
          minLength: 4
          maxLength: 20
          pattern: '^[a-zA-Z][a-zA-Z0-9_]{3,19}$'
        phone:
          type: string
          pattern: '^1[3-9]\d{9}$'
        email:
          type: string
          format: email
        password:
          type: string
          minLength: 8
          maxLength: 32
        smsCode:
          type: string
          pattern: '^\d{6}$'
```

---

## 三、技术问题解决方案

### 3.1 解决文件02生成失败

**方案A：纯文本输出模式**

放弃结构化输出，直接让模型输出纯文本内容：

```typescript
async function generateArtifactAsText(meta: FileRunMeta, fileId: string): Promise<string> {
  const model = createModel(meta, 60000);
  const prompt = buildPrompt(fileId, meta.requirement);
  
  const response = await model.invoke([
    new SystemMessage(getFilePrompt(fileId)),
    new HumanMessage(prompt)
  ]);
  
  return response.content as string;
}
```

**方案B：分段生成**

将长文件拆分为多个部分生成：

```typescript
async function generateInSegments(meta: FileRunMeta, fileId: string): Promise<string> {
  // 1. 先生成ER图和实体列表
  const entities = await generateEntities(meta);
  
  // 2. 为每个实体生成详细定义
  const definitions = [];
  for (const entity of entities) {
    const def = await generateEntityDefinition(meta, entity);
    definitions.push(def);
  }
  
  // 3. 生成DDL语句
  const ddl = await generateDDL(meta, entities);
  
  return combineResults(entities, definitions, ddl);
}
```

**方案C：增强JSON解析容错**

```typescript
function safeParseArtifactOutput(raw: string, key: string): string {
  // 1. 尝试直接解析
  try {
    const parsed = JSON.parse(raw);
    return parsed[key] ?? '';
  } catch {}
  
  // 2. 清理特殊字符后解析
  try {
    const cleaned = raw
      .replace(/[\x00-\x1F\x7F]/g, '') // 移除控制字符
      .replace(/\\(?!["\\/bfnrt])/g, '\\\\'); // 修复转义
    const parsed = JSON.parse(cleaned);
    return parsed[key] ?? '';
  } catch {}
  
  // 3. 提取JSON对象
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed[key] ?? '';
    } catch {}
  }
  
  // 4. 直接返回原始内容（降级处理）
  return raw;
}
```

### 3.2 提升文件内容质量

**方案：增强提示词模板**

为每个文件类型创建详细的提示词模板，明确要求输出实现规格：

```typescript
const FILE_PROMPTS = {
  '01': `
你是一个软件架构师。生成产品功能脑图与用例文档。

必须包含以下内容：
1. 功能架构脑图 (Mermaid graph TD格式)
2. 每个用例的实现规格：
   - API调用序列（端点、方法、请求体、响应体）
   - 数据验证规则（正则表达式、长度限制）
   - 业务规则（唯一性约束、有效期）
   - 错误码定义（错误码、说明、HTTP状态码）

输出格式要求：
- 使用Markdown格式
- 表格必须对齐
- 正则表达式必须可执行
- 错误码必须唯一
`,
  '02': `
你是一个数据库架构师。生成领域模型与物理表结构文档。

必须包含以下内容：
1. 领域模型图 (Mermaid erDiagram格式)
2. 每个实体的详细定义：
   - 字段定义（字段名、类型、约束、默认值、说明）
   - 索引定义（索引名、类型、字段）
   - 业务约束（加密算法、锁定策略等）
3. 完整DDL语句（可直接执行）

输出格式要求：
- 字段类型使用MySQL语法
- 索引命名规范：uk_前缀表示唯一索引，idx_前缀表示普通索引
- DDL语句必须完整可执行
`
};
```

---

## 四、改进后的工作流程

### 4.1 新的文件生成流程

```
用户选择需求文件
         │
         ▼
┌─────────────────────────────────────────────────────────────────┐
│  步骤1: 分析需求文档，提取关键实体和功能                          │
│  - 使用LLM提取实体列表                                           │
│  - 使用LLM提取功能列表                                           │
│  - 生成文件内容预估                                              │
└─────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────┐
│  步骤2: 生成文件01                                               │
│  - 使用增强提示词模板                                            │
│  - 输出实现规格（API序列、验证规则、错误码）                      │
│  - 用户确认后继续                                                │
└─────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────┐
│  步骤3: 生成文件02                                               │
│  - 使用纯文本输出模式（避免结构化输出问题）                        │
│  - 包含完整DDL语句                                               │
│  - 用户确认后继续                                                │
└─────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────┐
│  步骤4-8: 依次生成文件03-07                                      │
│  - 每个文件生成后用户确认                                        │
│  - 失败时自动重试（切换策略）                                     │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 智能重试策略

```
生成失败
    │
    ▼
┌─────────────────────────────────────┐
│  策略1: 结构化输出                   │
│  - 使用 withStructuredOutput()      │
│  - 适用于短内容                      │
└─────────────────────────────────────┘
    │ 失败
    ▼
┌─────────────────────────────────────┐
│  策略2: JSON Fallback               │
│  - 让模型输出JSON字符串              │
│  - 增强解析容错                      │
└─────────────────────────────────────┘
    │ 失败
    ▼
┌─────────────────────────────────────┐
│  策略3: 纯文本输出                   │
│  - 放弃结构化输出                    │
│  - 直接输出文件内容                  │
└─────────────────────────────────────┘
    │ 失败
    ▼
┌─────────────────────────────────────┐
│  策略4: 分段生成                     │
│  - 将文件拆分为多个部分              │
│  - 分别生成后合并                    │
└─────────────────────────────────────┘
    │ 全部失败
    ▼
  保存原始输出，让用户手动处理
```

---

## 五、可能的困难和风险

### 5.1 技术风险

| 风险 | 影响 | 缓解措施 | 用户需要确认 |
|-----|------|---------|-------------|
| **模型输出长度限制** | 长内容被截断 | 分段生成、纯文本输出 | 是否接受分段生成？ |
| **JSON解析失败** | 结构化输出失败 | 增强解析容错、纯文本输出 | - |
| **模型输出不稳定** | 同样输入不同结果 | 多次重试、结果缓存 | 重试次数上限？ |
| **上下文窗口限制** | 多文件生成时上下文超限 | 智能摘要、增量生成 | - |
| **生成时间过长** | 用户等待时间长 | 流式输出、进度展示 | 可接受的最长等待时间？ |

### 5.2 内容质量风险

| 风险 | 影响 | 缓解措施 | 用户需要确认 |
|-----|------|---------|-------------|
| **实现细节不足** | 智能体无法编码 | 增强提示词、Few-shot示例 | 是否需要提供示例文件？ |
| **跨文件不一致** | 实体名/字段名不匹配 | 传递上下文、一致性检查 | - |
| **格式不规范** | DDL无法执行、正则无效 | 后处理格式化、语法检查 | - |

### 5.3 产品风险

| 风险 | 影响 | 缓解措施 | 用户需要确认 |
|-----|------|---------|-------------|
| **用户确认流程繁琐** | 用户体验差 | 提供批量确认选项 | 是否需要批量确认模式？ |
| **修改意见不明确** | 模型无法理解修改要求 | 提供修改建议模板 | - |
| **断点续传需求** | 中断后需要重新开始 | 保存中间状态 | 是否需要断点续传？ |

---

## 六、待用户确认的问题

### 6.1 技术决策

- [ ] **生成策略**：是否接受分段生成？（可能影响内容一致性）
- [ ] **重试策略**：重试次数上限是多少？（建议3次）
- [ ] **超时设置**：单个文件生成的最长等待时间？（建议90秒）
- [ ] **断点续传**：是否需要支持中断后继续？

### 6.2 内容质量

- [ ] **示例文件**：是否需要提供高质量的示例文件作为Few-shot？
- [ ] **技术栈**：目标技术栈是什么？（影响DDL语法、API风格）
- [ ] **详细程度**：每个文件需要多详细？（当前设计是否满足需求？）

### 6.3 用户体验

- [ ] **确认模式**：逐个确认还是批量确认？
- [ ] **修改方式**：自由文本还是结构化表单？
- [ ] **进度展示**：需要什么样的进度提示？

---

## 七、实施步骤

### 阶段一：修复当前失败问题（紧急）

| 步骤 | 任务 | 预期效果 |
|-----|------|---------|
| 1.1 | 实现纯文本输出模式 | 绕过结构化输出限制 |
| 1.2 | 增强JSON解析容错 | 提高解析成功率 |
| 1.3 | 实现智能重试策略 | 自动切换生成策略 |
| 1.4 | 测试文件02-04生成 | 验证修复效果 |

### 阶段二：提升内容质量（高优先级）

| 步骤 | 任务 | 预期效果 |
|-----|------|---------|
| 2.1 | 设计增强提示词模板 | 输出实现规格而非业务描述 |
| 2.2 | 准备Few-shot示例 | 提高输出质量 |
| 2.3 | 实现内容格式化 | 确保DDL可执行、正则有效 |
| 2.4 | 测试智能体可用性 | 验证文件是否可直接用于编码 |

### 阶段三：优化用户体验（中优先级）

| 步骤 | 任务 | 预期效果 |
|-----|------|---------|
| 3.1 | 实现流式输出 | 实时展示生成进度 |
| 3.2 | 实现断点续传 | 支持中断后继续 |
| 3.3 | 实现批量确认 | 提高操作效率 |
| 3.4 | 完善错误提示 | 帮助用户理解问题 |

---

## 八、MCP工具集成分析

### 8.1 可用MCP工具汇总

根据网络调研，以下MCP工具可以直接用于替代部分功能：

#### 图表生成类

| 工具名称 | 来源 | 功能 | 可用于文件 |
|---------|------|------|-----------|
| **mcp-diagram-server** | https://github.com/angrysky56/mcp-diagram-server | 支持流程图、时序图、类图、ER图、状态图、脑图、甘特图等，8+预置模板 | 01, 02, 03 |
| **mermaid-mcp-server** | https://www.npmjs.com/package/@narasimhaponnada/mermaid-mcp-server | 支持Mermaid所有图表类型，SVG导出，语法验证 | 01, 02, 03 |
| **mcp-diagram-generator** | https://www.npmjs.com/package/mcp-diagram-generator | 支持Draw.io、Mermaid、Excalidraw三种格式 | 01, 02, 03 |

#### API文档生成类

| 工具名称 | 来源 | 功能 | 可用于文件 |
|---------|------|------|-----------|
| **openapi-mcp-generator** | https://github.com/salacoste/openapi-mcp-generator | 从OpenAPI规范生成MCP服务器，支持v2/v3 | 04 |
| **swagger-mcp-server** | https://github.com/tuskermanshu/swagger-mcp-server | 解析Swagger/OpenAPI，生成TypeScript类型和API客户端 | 04 |
| **api-tester-mcp** | https://www.npmjs.com/package/@kirti676/api-tester-mcp | 支持OpenAPI/Swagger、Postman集合、GraphQL，自动生成测试场景 | 04, 05, 07 |

#### 数据库操作类

| 工具名称 | 来源 | 功能 | 可用于文件 |
|---------|------|------|-----------|
| **sql-server-pro** | https://mcpdir.dev/servers/sql-server-pro | 23个数据库管理工具，DDL/DML操作，表结构管理 | 02 |
| **mssql-mcp-server** | https://juejin.cn/post/7547672829895655433 | 企业级DDL支持，权限控制，SQL注入防护 | 02 |

#### 测试生成类

| 工具名称 | 来源 | 功能 | 可用于文件 |
|---------|------|------|-----------|
| **automation-script-generator-mcp** | https://himcp.ai/server/automation-script-generator-mcp-server | WDIO框架测试脚本生成，支持Gherkin语法 | 05 |
| **mcp-gherkin-server** | https://ubos.tech/mcp/mcp-gherkin-server | 专门生成Gherkin文件的MCP服务器 | 05 |
| **RobotMCP** | https://github.com/manykarim/rf-mcp | AI驱动的测试自动化，支持BDD风格 | 05 |
| **Quality MCP** | https://lobehub.com/mcp/jorgsouza-mcp-quality-cli | 多语言测试生成（Playwright、Vitest、Jest等） | 05 |

#### UI原型生成类

| 工具名称 | 来源 | 功能 | 可用于文件 |
|---------|------|------|-----------|
| **AI-Diagram-Prototype-Generator** | https://github.com/SimonUTD/AI-Diagram-Prototype-Generator-MCP-Server | AI驱动的图表和原型生成 | 06 |
| **Figma MCP Server** | https://himcp.ai/server/figma-mcp-server-xuu | 从Figma设计生成HTML/CSS，截图捕获 | 06 |
| **@uxai/mcp-server** | https://www.npmjs.com/package/@uxai/mcp-server | 设计系统集成，UI原型管理，组件生成 | 06 |
| **modao-proto-mcp** | https://github.com/modao-dev/modao-proto-mcp | 连接设计工具与AI模型 | 06 |

#### Postman集成类

| 工具名称 | 来源 | 功能 | 可用于文件 |
|---------|------|------|-----------|
| **Postman MCP** | https://blog.postman.com/postman-launches-full-support-for-model-context-protocol-mcp | 完整MCP协议支持，可视化API调试，集合管理 | 07 |

### 8.2 文件与MCP工具映射

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      JAP Plus MCP工具集成方案                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  文件01: 产品功能脑图与用例.md                                                │
│  ├── Mermaid脑图生成 ──► mcp-diagram-server / mermaid-mcp-server            │
│  └── 用例实现规格 ──► LLM + 增强提示词 (需要自己实现)                          │
│                                                                             │
│  文件02: 领域模型与物理表结构.md                                              │
│  ├── ER图生成 ──► mcp-diagram-server / mermaid-mcp-server                   │
│  ├── 表结构设计 ──► sql-server-pro / mssql-mcp-server                       │
│  └── DDL语句生成 ──► sql-server-pro / mssql-mcp-server                      │
│                                                                             │
│  文件03: 核心业务状态机.md                                                    │
│  └── 状态图生成 ──► mcp-diagram-server / mermaid-mcp-server                 │
│                                                                             │
│  文件04: RESTful API契约.yaml                                                │
│  └── OpenAPI生成 ──► swagger-mcp-server / openapi-mcp-generator             │
│                                                                             │
│  文件05: 行为驱动验收测试.md                                                  │
│  └── Gherkin测试场景 ──► mcp-gherkin-server / automation-script-generator   │
│                                                                             │
│  文件06: UI原型与交互草图.html                                                │
│  └── HTML原型生成 ──► Figma MCP Server / @uxai/mcp-server                   │
│                                                                             │
│  文件07: API调试集合.json                                                    │
│  └── Postman集合 ──► Postman MCP / api-tester-mcp                           │
│                                                                             │
│  文件R1: 建模一致性审查.md                                                    │
│  └── 一致性检查 ──► 需要自己实现                                              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 8.3 需要自己实现的功能

| 功能 | 原因 | 替代方案 |
|-----|------|---------|
| **用例实现规格生成** | MCP工具主要处理格式转换，不处理业务逻辑到实现规格的转换 | 使用LLM + 增强提示词 |
| **一致性审查** | 没有找到跨文件一致性检查的MCP工具 | 使用LLM进行审查 + 自定义验证脚本 |
| **内容质量增强** | MCP工具不处理内容质量 | Few-shot示例 + 增强提示词 |

### 8.4 推荐的集成策略

#### 第一阶段：集成现有MCP工具

| 文件 | 策略 | 工具 | 优先级 |
|-----|------|-----|-------|
| 01 | LLM生成内容 + MCP生成图表 | mcp-diagram-server | 高 |
| 02 | LLM生成内容 + MCP生成DDL | sql-server-pro | 高 |
| 03 | LLM生成内容 + MCP生成图表 | mcp-diagram-server | 高 |
| 04 | MCP生成OpenAPI | swagger-mcp-server | 高 |
| 05 | MCP生成Gherkin | mcp-gherkin-server | 高 |
| 06 | MCP生成HTML原型 | @uxai/mcp-server 或 Figma MCP | 中 |
| 07 | MCP生成Postman集合 | Postman MCP | 高 |

#### 第二阶段：增强内容质量

- 设计详细的提示词模板
- 准备Few-shot示例
- 实现输出格式验证

#### 第三阶段：实现缺失功能

- 用例实现规格生成
- 一致性审查功能

---

## 九、文件清单与依赖关系

### 9.1 完整文件列表

| 文件ID | 文件名 | 状态 | 依赖 | MCP工具 | 内容要点 |
|-------|-------|------|-----|---------|---------|
| 01 | 产品功能脑图与用例.md | ✅ 已生成 | 无 | mcp-diagram-server | 功能架构、用例实现规格、API序列、验证规则 |
| 02 | 领域模型与物理表结构.md | ❌ 失败 | 01 | sql-server-pro, mcp-diagram-server | ER图、字段定义、索引、DDL语句 |
| 03 | 核心业务状态机.md | ⏳ 待生成 | 01,02 | mcp-diagram-server | 状态图、转换条件、触发事件 |
| 04 | RESTful API契约.yaml | ⏳ 待生成 | 01,02,03 | swagger-mcp-server | OpenAPI规范、请求/响应定义 |
| R1 | 建模一致性审查.md | ⏳ 待生成 | 01,02,03,04 | 无（需自己实现） | 跨文件一致性检查 |
| 05 | 行为驱动验收测试.md | ⏳ 待生成 | 01,02,03,04 | mcp-gherkin-server | Gherkin测试场景 |
| 06 | UI原型与交互草图.html | ⏳ 待生成 | 01,04 | @uxai/mcp-server | 完整HTML页面 |
| 07 | API调试集合.json | ⏳ 待生成 | 04 | Postman MCP | Postman Collection |

### 9.2 文件依赖关系图

```
01_产品功能脑图与用例.md
    │
    ├──► 02_领域模型与物理表结构.md
    │         │
    │         └──► 03_核心业务状态机.md
    │                   │
    └───────────────────┼──► 04_RESTful_API契约.yaml
                        │         │
                        │         ├──► 05_行为驱动验收测试.md
                        │         │
                        │         ├──► 06_UI原型与交互草图.html
                        │         │
                        │         └──► 07_API调试集合.json
                        │
                        └──► R1_建模一致性审查.md
```

---

## 十、系统其他问题分析

### 10.1 性能问题

#### 问题1：LLM调用串行执行

**当前状态**：
```typescript
// taskRoutes.ts - 文件生成是串行的
for (const key of MODELING_OUTPUT_KEYS) {
  emitLogAdded("INFO", MODELING_NODE_LOG_TEXT.startTitle, `Generating ${key}`);
  const { content } = await generateModelingArtifact(...);  // 等待完成
  result[key] = content;
}
```

**问题**：每个文件生成必须等待上一个完成，总耗时 = 单个文件耗时 × 文件数量

**改进方案**：
```typescript
// 并行生成无依赖的文件
const [file01, file03] = await Promise.all([
  generateFile01(meta),
  generateFile03(meta),  // 如果03不依赖01
]);
```

**预期效果**：生成时间减少 30-50%

---

#### 问题2：上下文重复加载

**当前状态**：
```typescript
// 每次生成都重新加载skill context
const rawSkillContext = await loadSkillContext(state.workspaceConfig?.path);
```

**问题**：虽然有缓存，但缓存粒度太粗（整个文件），无法增量更新

**改进方案**：
- 实现增量缓存
- 预加载常用上下文
- 使用内存池管理

---

#### 问题3：WebSocket广播效率低

**当前状态**：
```typescript
// websocket.ts - 遍历所有客户端
function broadcast(message: string): void {
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}
```

**问题**：每次事件都广播给所有客户端，包括不相关的客户端

**改进方案**：
```typescript
// 按任务ID分组广播
const taskClients = new Map<string, Set<WebSocket>>();

function broadcastToTask(taskId: string, message: string): void {
  const clients = taskClients.get(taskId);
  if (clients) {
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }
}
```

---

### 10.2 架构问题

#### 问题1：状态管理分散

**当前状态**：
- `JapState` 在 `japState.ts`
- `FileRunMeta` 在 `taskRoutes.ts`
- 两套状态系统，数据不同步

**问题**：状态管理混乱，难以维护

**改进方案**：
- 统一状态管理接口
- 使用单一数据源
- 实现状态持久化

---

#### 问题2：错误处理不统一

**当前状态**：
```typescript
// 不同地方有不同的错误处理方式
throw new Error("...");
return { errors: [...state.errors, message] };
emitLogAdded("ERROR", ...);
```

**问题**：错误处理分散，难以追踪和恢复

**改进方案**：
```typescript
// 统一错误处理
class JapError extends Error {
  constructor(
    public code: string,
    public message: string,
    public recoverable: boolean = false,
    public context?: Record<string, unknown>
  ) {
    super(message);
  }
}

// 错误恢复策略
const errorRecoveryStrategies: Record<string, () => Promise<void>> = {
  'LLM_TIMEOUT': async () => { /* 重试 */ },
  'PARSE_ERROR': async () => { /* 切换策略 */ },
};
```

---

#### 问题3：缺少抽象层

**当前状态**：LLM调用、MCP调用、文件操作都直接写在业务代码中

**问题**：难以替换底层实现，难以测试

**改进方案**：
```typescript
// 抽象LLM服务
interface LLMService {
  generate(prompt: string, options?: GenerateOptions): Promise<string>;
  generateStructured<T>(prompt: string, schema: ZodSchema<T>): Promise<T>;
}

// 抽象文件服务
interface FileService {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}
```

---

### 10.3 可扩展性问题

#### 问题1：文件类型硬编码

**当前状态**：
```typescript
const FILE_SPECS: ReadonlyArray<FileSpec> = [
  { fileId: "01", stage: "MODELING", artifactName: "...", ext: "md" },
  // ...
];
```

**问题**：添加新文件类型需要修改代码

**改进方案**：
```typescript
// 配置驱动的文件定义
interface ArtifactConfig {
  id: string;
  name: string;
  extension: string;
  stage: string;
  dependencies: string[];
  generator: 'llm' | 'mcp' | 'custom';
  mcpTool?: string;
  promptTemplate?: string;
}

// 从配置文件加载
const artifacts: ArtifactConfig[] = await loadArtifactConfig();
```

---

#### 问题2：提示词硬编码

**当前状态**：
```typescript
export const MODELING_NODE_SYSTEM_PROMPT = `
You are a top-tier AI software architect.
...
`;
```

**问题**：修改提示词需要修改代码和重新部署

**改进方案**：
- 提示词模板外部化
- 支持热更新
- 版本管理

---

#### 问题3：缺少插件机制

**当前状态**：所有功能都在核心代码中

**问题**：无法动态扩展功能

**改进方案**：
```typescript
// 插件接口
interface JapPlugin {
  name: string;
  version: string;
  onFileGenerated?(fileId: string, content: string): Promise<void>;
  onFileApproved?(fileId: string): Promise<void>;
  customGenerator?(fileId: string, meta: FileRunMeta): Promise<string>;
}

// 插件注册
class PluginManager {
  private plugins: Map<string, JapPlugin> = new Map();
  
  register(plugin: JapPlugin): void {
    this.plugins.set(plugin.name, plugin);
  }
  
  async trigger(hook: string, ...args: unknown[]): Promise<void> {
    for (const plugin of this.plugins.values()) {
      const handler = (plugin as any)[hook];
      if (handler) {
        await handler.apply(plugin, args);
      }
    }
  }
}
```

---

### 10.4 可维护性问题

#### 问题1：缺少测试

**当前状态**：没有测试文件

**问题**：修改代码容易引入bug

**改进方案**：
- 单元测试：测试核心函数
- 集成测试：测试API端点
- E2E测试：测试完整流程

---

#### 问题2：日志不完整

**当前状态**：
```typescript
emitLogAdded("INFO", title, summary);
```

**问题**：缺少结构化日志、缺少追踪ID、缺少性能指标

**改进方案**：
```typescript
interface StructuredLog {
  timestamp: string;
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  traceId: string;
  spanId: string;
  message: string;
  context: Record<string, unknown>;
  duration?: number;
}

// 结构化日志
logger.info('file_generation_started', {
  fileId: '01',
  attempt: 1,
  estimatedTokens: 5000,
});
```

---

#### 问题3：缺少监控指标

**当前状态**：没有性能监控

**问题**：无法了解系统运行状态

**改进方案**：
```typescript
// Prometheus风格的指标
const metrics = {
  file_generation_duration: new Histogram({
    name: 'jap_file_generation_duration_seconds',
    help: 'Duration of file generation',
    labelNames: ['fileId', 'strategy'],
  }),
  llm_tokens_used: new Counter({
    name: 'jap_llm_tokens_total',
    help: 'Total tokens used',
    labelNames: ['model', 'type'],
  }),
  generation_success_rate: new Gauge({
    name: 'jap_generation_success_rate',
    help: 'Success rate of file generation',
    labelNames: ['fileId'],
  }),
};
```

---

### 10.5 安全问题

#### 问题1：API Key暴露

**当前状态**：
```typescript
// meta.json中明文存储
"llm": {
  "apiKey": "sk-b197051bd6a04d26930dcb3f547f252d",
  ...
}
```

**问题**：API Key明文存储，存在安全风险

**改进方案**：
- 使用环境变量
- 加密存储敏感信息
- 使用密钥管理服务

---

#### 问题2：缺少输入验证

**当前状态**：
```typescript
const requirement = String(req.body?.requirement ?? "").trim();
```

**问题**：只做了基本验证，缺少深度验证

**改进方案**：
```typescript
// 使用Zod进行严格验证
const RequirementSchema = z.string()
  .min(50, "需求描述至少50字符")
  .max(50000, "需求描述最多50000字符")
  .refine(
    (s) => !containsMaliciousContent(s),
    "需求描述包含不允许的内容"
  );
```

---

#### 问题3：缺少速率限制

**当前状态**：API没有速率限制

**问题**：可能被滥用

**改进方案**：
```typescript
import rateLimit from 'express-rate-limit';

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15分钟
  max: 100, // 每个IP最多100次请求
  message: '请求过于频繁，请稍后再试',
});

app.use('/api/', limiter);
```

---

### 10.6 用户体验问题

#### 问题1：缺少进度预估

**当前状态**：只显示"正在生成"

**问题**：用户不知道还要等多久

**改进方案**：
```typescript
// 基于历史数据预估时间
const estimatedTime = await estimateGenerationTime(fileId, contentLength);
emitProgress({
  current: 0,
  total: 100,
  estimatedSeconds: estimatedTime,
  message: `预计需要 ${Math.ceil(estimatedTime / 60)} 分钟`,
});
```

---

#### 问题2：缺少断点续传

**当前状态**：中断后需要重新开始

**问题**：浪费时间和资源

**改进方案**：
- 保存中间状态
- 支持从任意文件继续
- 恢复上下文

---

#### 问题3：缺少预览功能

**当前状态**：生成完成后才能看到内容

**问题**：无法提前发现问题

**改进方案**：
- 流式输出预览
- 实时渲染Mermaid图
- 格式检查提示

---

## 十一、问题优先级排序

| 优先级 | 问题类别 | 具体问题 | 影响 | 改进成本 |
|-------|---------|---------|------|---------|
| P0 | 稳定性 | 文件02生成失败 | 阻塞 | 中 |
| P0 | 质量 | 内容缺少实现细节 | 核心目标 | 中 |
| P1 | 性能 | LLM调用串行执行 | 效率 | 低 |
| P1 | 安全 | API Key明文存储 | 安全风险 | 低 |
| P2 | 可维护性 | 缺少测试 | 维护成本 | 高 |
| P2 | 用户体验 | 缺少进度预估 | 体验 | 低 |
| P2 | 架构 | 状态管理分散 | 维护成本 | 中 |
| P3 | 可扩展性 | 文件类型硬编码 | 扩展性 | 中 |
| P3 | 可扩展性 | 缺少插件机制 | 扩展性 | 高 |
| P3 | 性能 | WebSocket广播效率 | 性能 | 低 |

---

## 十二、待用户确认的问题

### 12.1 性能优化

- [ ] 是否需要并行生成文件？（可能影响上下文一致性）
- [ ] 是否需要实现流式输出？
- [ ] 可接受的最长生成时间？

### 12.2 架构改进

- [ ] 是否需要统一状态管理？
- [ ] 是否需要插件机制？
- [ ] 是否需要配置驱动？

### 12.3 安全加固

- [ ] API Key存储方式：环境变量 / 加密存储 / 密钥管理服务？
- [ ] 是否需要速率限制？
- [ ] 是否需要输入内容审核？

### 12.4 可维护性

- [ ] 是否需要添加测试？
- [ ] 是否需要结构化日志？
- [ ] 是否需要监控指标？

---

## 十三、AI Agent最佳实践借鉴

### 13.1 九大设计模式

根据2025年业界研究，以下是主流的AI Agent设计模式：

#### 模式1：ReAct（推理-行动循环）

**原理**：模拟人类「思考→行动→观察」的闭环认知过程

```
用户问："北京今日适合洗车吗？"
Agent行动流：
思考：需获取实时天气、洗车指数
行动：并行调用气象API与环境监测接口
观察：接收降雨概率40%、PM2.5超标数据
再思考：综合判定"不建议露天洗车"
（循环直至置信度>95%）
```

**适用场景**：代码调试、动态数据查询等高精度场景

**JAP Plus应用**：可用于文件生成过程中的动态调整

---

#### 模式2：Plan-and-Solve（全局规划）

**原理**：将"边做边想"升级为"全局规划→动态执行→弹性调整"

```
[初始计划]
1. 景点调研：调用TripAdvisor API
2. 住宿预订：调用Booking API
3. 交通调度：调用JR时刻表API

[动态调整]
→ 执行Step1时发现「交通管制」
→ 重新规划：Step2优先预订京都住宿
```

**适用场景**：项目管理、多步骤工作流自动化

**JAP Plus应用**：可用于文件生成的整体规划

---

#### 模式3：REWOO（推理-执行解耦）

**原理**：分离推理与工具调用，消除串行等待瓶颈

| 模式 | 4步任务耗时 | API调用次数 |
|-----|-----------|------------|
| ReAct | 8.2s | 4次 |
| REWOO | 3.1s | 1次 |

**JAP Plus应用**：可用于并行生成多个文件

---

#### 模式4：LLMCompiler（DAG并行加速）

**原理**：通过有向无环图编译任务依赖关系，实现最大化并行化

```
问题："比较张译与吴京的年龄"
传统模式：顺序查询（2.1s）
LLMCompiler：并行调用百度/维基API（0.8s）
```

**三大组件**：
- 规划器：自动构建任务DAG
- 调度器：动态分配计算资源
- 融合器：处理异构结果

**JAP Plus应用**：可用于并行生成无依赖的文件

---

#### 模式5：Reflection（自反思）

**原理**：Agent检查自己的输出并迭代改进

```python
def reflection_pattern(task: str, max_iterations: int = 3) -> str:
    output = generate(task)
    
    for i in range(max_iterations):
        critique = evaluate(output, task)
        if critique.is_satisfactory:
            break
        output = generate(task, previous=output, feedback=critique)
    
    return output
```

**适用场景**：写作、代码生成、分析推理

**JAP Plus应用**：可用于文件生成后的质量检查

---

#### 模式6：Reflexion（实证驱动进化）

**原理**：在Reflection基础上增加外部验证与经验沉淀

**四元闭环**：
1. 生成初始输出
2. 外部验证（如单元测试）
3. 反思错误原因
4. 存储经验到记忆库

**效果**：30天错误率下降65%

**JAP Plus应用**：可用于文件一致性检查和错误修复

---

#### 模式7：LATS（树搜索决策）

**原理**：结合蒙特卡洛树搜索与多模式协同

- 全局探索：构建任务决策树
- 局部优化：在关键节点注入ReAct循环
- 动态剪枝：淘汰低分路径

**效果**：决策质量提升42%

**JAP Plus应用**：可用于复杂场景的文件生成策略选择

---

#### 模式8：Self-Discover（自适应模式引擎）

**原理**：Agent自主诊断任务特征，动态组装最优模式链

```python
def self_discover(task):
    if task.complexity > 0.8 and task.verification_needed:
        return [Reflexion, LATS]  # 严格验证+多路径探索
    elif task.creativity > 0.7:
        return [Basic Reflection, Storm]  # 创意增强
    else:
        return [REWOO]  # 标准化流程
```

**JAP Plus应用**：可用于根据文件类型自动选择生成策略

---

#### 模式9：Multi-Agent Collaboration（多智能体协作）

**原理**：多个专业化Agent协同工作

```python
# 定义专业化Agent
researcher = Agent(role="Research specialist", tools=[web_search])
analyst = Agent(role="Data analyst", tools=[calculator, database])
writer = Agent(role="Content writer", tools=[])

# 协作流程
def multi_agent_task(task: str) -> str:
    research = researcher.execute(f"Research: {task}")
    analysis = analyst.execute(f"Analyze: {research}")
    report = writer.execute(f"Write report on: {analysis}")
    return report
```

**JAP Plus应用**：可用于不同文件由不同专业化Agent生成

---

### 13.2 提高效率的技术

#### 技术1：语义缓存（Semantic Caching）

**原理**：识别语义相似的查询，复用缓存结果

**效果**：延迟减少高达65倍

```typescript
// 实现示例
interface SemanticCache {
  // 查询缓存
  query(prompt: string): Promise<CachedResponse | null>;
  
  // 存储结果
  store(prompt: string, response: string, embedding: number[]): void;
}

// 使用向量数据库实现
class VectorSemanticCache implements SemanticCache {
  async query(prompt: string): Promise<CachedResponse | null> {
    const embedding = await this.embed(prompt);
    const similar = await this.vectorDB.search(embedding, { threshold: 0.95 });
    return similar[0]?.response ?? null;
  }
}
```

**JAP Plus应用**：
- 缓存相似需求的生成结果
- 缓存常用的上下文片段
- 减少重复的LLM调用

---

#### 技术2：分层记忆机制

**原理**：短期记忆 + 长期记忆 + 反思记忆

| 记忆类型 | 用途 | 存储方式 |
|---------|------|---------|
| 短期记忆 | 当前任务上下文 | 内存缓存 |
| 长期记忆 | 跨会话知识 | 向量数据库 |
| 反思记忆 | 经验策略 | 结构化存储 |

```typescript
interface AgentMemory {
  shortTerm: {
    add(key: string, value: any, ttl: number): void;
    get(key: string): any;
  };
  
  longTerm: {
    store(experience: Experience): Promise<void>;
    recall(query: string): Promise<Experience[]>;
  };
  
  reflective: {
    recordLesson(lesson: Lesson): Promise<void>;
    getRelevantLessons(context: string): Promise<Lesson[]>;
  };
}
```

**JAP Plus应用**：
- 短期记忆：当前生成任务的上下文
- 长期记忆：历史生成的文件模板
- 反思记忆：生成失败的教训

---

#### 技术3：DAG并行执行

**原理**：分析任务依赖关系，并行执行无依赖的任务

```typescript
// 构建任务依赖图
const taskDAG = {
  '01': [],           // 无依赖
  '02': ['01'],       // 依赖01
  '03': ['01', '02'], // 依赖01和02
  '04': ['01', '02', '03'],
  '05': ['04'],
  '06': ['04'],
  '07': ['04'],
};

// 并行执行
async function executeDAG(dag: TaskDAG): Promise<Results> {
  const completed = new Set<string>();
  const results: Results = {};
  
  while (completed.size < Object.keys(dag).length) {
    // 找出所有依赖已满足的任务
    const ready = Object.entries(dag)
      .filter(([id, deps]) => !completed.has(id) && deps.every(d => completed.has(d)))
      .map(([id]) => id);
    
    // 并行执行这些任务
    const batchResults = await Promise.all(
      ready.map(id => executeTask(id).then(r => ({ id, result: r })))
    );
    
    // 收集结果
    for (const { id, result } of batchResults) {
      results[id] = result;
      completed.add(id);
    }
  }
  
  return results;
}
```

**JAP Plus应用**：
- 文件05、06、07可以并行生成（都只依赖04）
- 预计减少30-50%生成时间

---

### 13.3 提高输出质量的技术

#### 技术1：双Agent协作（Generator + Critic）

**原理**：一个Agent负责生成，另一个Agent负责审查

```typescript
interface DualAgentSystem {
  generator: Agent;  // 生成者
  critic: Agent;     // 评论者
  
  async generate(task: string): Promise<string> {
    let output = await this.generator.execute(task);
    
    for (let i = 0; i < 3; i++) {
      const critique = await this.critic.execute({
        task,
        output,
        role: 'critique'
      });
      
      if (critique.score >= 0.9) {
        break;
      }
      
      output = await this.generator.execute({
        task,
        previousOutput: output,
        feedback: critique,
        role: 'revise'
      });
    }
    
    return output;
  }
}
```

**JAP Plus应用**：
- 生成Agent：负责生成文件内容
- 审查Agent：检查内容质量、一致性、完整性

---

#### 技术2：Chain of Thought (CoT)

**原理**：引导模型分步骤推理

```
传统提示：
"生成用户登录的API契约"

CoT提示：
"生成用户登录的API契约，请按以下步骤思考：
1. 首先分析登录流程涉及的所有实体
2. 然后确定每个实体需要的字段
3. 接着设计API端点和请求/响应结构
4. 最后考虑错误处理和边界情况"
```

**JAP Plus应用**：在提示词中加入CoT引导

---

#### 技术3：自验证（Self-Verification）

**原理**：模型自己验证输出的正确性

```typescript
async function generateWithVerification(task: string): Promise<string> {
  const output = await generate(task);
  
  const verification = await verify({
    output,
    criteria: [
      '是否包含所有必需字段？',
      '格式是否正确？',
      '是否与需求一致？',
    ]
  });
  
  if (!verification.passed) {
    return generate({
      task,
      previousOutput: output,
      issues: verification.issues,
      role: 'fix'
    });
  }
  
  return output;
}
```

**JAP Plus应用**：文件生成后自动验证

---

#### 技术4：多路径推理（Self-Consistency）

**原理**：生成多个推理路径，选择最一致的结果

```typescript
async function selfConsistency(task: string, paths: number = 3): Promise<string> {
  // 生成多个推理路径
  const results = await Promise.all(
    Array(paths).fill(0).map(() => generate(task))
  );
  
  // 选择最一致的结果
  const consistency = analyzeConsistency(results);
  return consistency.mostConsistent;
}
```

**JAP Plus应用**：对关键文件生成多个版本，选择最佳

---

### 13.4 JAP Plus可借鉴的改进方案

#### 方案1：引入双Agent协作

```
当前流程：
LLM生成文件 → 用户确认

改进后流程：
Generator Agent → Critic Agent → 用户确认
     ↑________________↓
        (反馈修正)
```

**实现要点**：
- Generator专注内容生成
- Critic检查：完整性、一致性、格式正确性
- 最多3轮迭代

---

#### 方案2：引入语义缓存

```
当前流程：
每次生成 → LLM调用 → 返回结果

改进后流程：
每次生成 → 检查语义缓存 → 命中？
                              ↓是        ↓否
                          返回缓存    LLM调用 → 存入缓存 → 返回结果
```

**实现要点**：
- 使用向量数据库存储缓存
- 相似度阈值0.95
- 缓存过期时间24小时

---

#### 方案3：引入DAG并行执行

```
当前流程：
01 → 02 → 03 → 04 → 05 → 06 → 07 (串行)

改进后流程：
01 → 02 → 03 → 04 → [05, 06, 07] (并行)
                  └── R1 (并行)
```

**实现要点**：
- 分析文件依赖关系
- 并行执行无依赖文件
- 预计减少30-50%时间

---

#### 方案4：引入自反思机制

```
当前流程：
生成文件 → 保存

改进后流程：
生成文件 → 自我评估 → 质量达标？
                          ↓否        ↓是
                      反思修正      保存
                          ↓
                      重新生成
```

**实现要点**：
- 定义质量评估标准
- 最多3轮迭代
- 记录反思经验

---

#### 方案5：引入专业化Agent

```
当前流程：
通用LLM → 生成所有文件

改进后流程：
架构师Agent → 生成01, 02, 03
API设计师Agent → 生成04
测试工程师Agent → 生成05
前端工程师Agent → 生成06
DevOps Agent → 生成07
```

**实现要点**：
- 每个Agent有专业化提示词
- 共享上下文和依赖文件
- 协调器管理协作流程

---

### 13.5 技术选型建议

| 改进目标 | 推荐技术 | 实现难度 | 预期效果 |
|---------|---------|---------|---------|
| 提高生成速度 | DAG并行执行 | 低 | 减少30-50%时间 |
| 提高生成速度 | 语义缓存 | 中 | 减少65倍延迟（命中时） |
| 提高输出质量 | 双Agent协作 | 中 | 质量提升20-30% |
| 提高输出质量 | 自反思机制 | 中 | 错误率下降65% |
| 提高一致性 | CoT提示 | 低 | 推理准确性提升 |
| 支持复杂场景 | 专业化Agent | 高 | 专业度提升 |

---

*文档版本: v3.3*
*创建日期: 2026-04-12*
*状态: 待用户确认*
*更新: 添加AI Agent最佳实践借鉴*
