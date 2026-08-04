import { useRef, useEffect } from 'react'
import { EditorView, keymap, placeholder as cmPlaceholder, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { sql, MySQL, PostgreSQL, SQLite, MSSQL, PLSQL } from '@codemirror/lang-sql'
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldGutter } from '@codemirror/language'
import { autocompletion, closeBrackets, CompletionContext } from '@codemirror/autocomplete'
import type { CompletionResult, Completion } from '@codemirror/autocomplete'

interface SqlEditorProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  height?: string
  dialect?: 'mysql' | 'postgresql' | 'sqlite' | 'mssql' | 'plsql'
  readOnly?: boolean
  tables?: Record<string, string[]>
  variables?: Array<{ name: string; label?: string }>  // 可用变量列表
}

const dialectMap = {
  mysql: MySQL,
  postgresql: PostgreSQL,
  sqlite: SQLite,
  mssql: MSSQL,
  plsql: PLSQL,
}

// 变量自动完成函数
function variableCompleter(variables: Array<{ name: string; label?: string }>) {
  return (context: CompletionContext): CompletionResult | null => {
    // 获取光标位置前的文本
    const textBefore = context.state.doc.sliceString(0, context.pos)

    // 查找最后一个$符号的位置
    const lastDollarIndex = textBefore.lastIndexOf('$')

    if (lastDollarIndex === -1) return null

    // 检查$符号后面是否紧跟着合法的变量名字符（字母、数字、下划线）
    const afterDollar = textBefore.slice(lastDollarIndex + 1, context.pos)
    if (!/^[a-zA-Z0-9_]*$/.test(afterDollar)) return null

    // 确保$符号前面不是字母、数字、下划线（避免在标识符中间或变量名中间触发）
    if (lastDollarIndex > 0) {
      const charBefore = textBefore[lastDollarIndex - 1]
      if (/[a-zA-Z0-9_]/.test(charBefore)) return null
    }

    // 构建变量选项 - 只显示变量名部分（不包含$）
    const options = variables.map(v => ({
      label: v.name,
      type: 'variable' as const,
      detail: v.label || v.name,
      info: `变量: ${v.label || v.name}`,
      apply: v.name,
    }))

    return {
      from: lastDollarIndex + 1, // 从$后面开始替换
      options,
      validFor: /^[a-zA-Z0-9_]*$/,
    }
  }
}

// SQL 关键字自动完成
const SQL_KEYWORDS = [
  // DML
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'LIKE', 'BETWEEN',
  'IS', 'NULL', 'AS', 'DISTINCT', 'ALL', 'JOIN', 'INNER', 'LEFT', 'RIGHT',
  'OUTER', 'FULL', 'ON', 'GROUP', 'BY', 'HAVING', 'ORDER', 'ASC', 'DESC',
  'LIMIT', 'OFFSET', 'UNION', 'INTERSECT', 'EXCEPT',

  // DDL
  'CREATE', 'ALTER', 'DROP', 'TABLE', 'INDEX', 'VIEW', 'DATABASE', 'SCHEMA',
  'TRIGGER', 'PROCEDURE', 'FUNCTION',

  // 数据类型
  'INT', 'INTEGER', 'BIGINT', 'SMALLINT', 'DECIMAL', 'NUMERIC', 'FLOAT',
  'DOUBLE', 'REAL', 'CHAR', 'VARCHAR', 'TEXT', 'DATE', 'DATETIME', 'TIMESTAMP',
  'TIME', 'BOOLEAN', 'BOOL', 'BLOB', 'JSON',

  // 聚合函数
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'GROUP_CONCAT',

  // 字符串函数
  'CONCAT', 'SUBSTRING', 'UPPER', 'LOWER', 'LENGTH', 'TRIM', 'LTRIM', 'RTRIM',
  'REPLACE', 'REVERSE', 'LEFT', 'RIGHT', 'LPAD', 'RPAD',

  // 日期函数
  'NOW', 'CURDATE', 'CURTIME', 'YEAR', 'MONTH', 'DAY', 'HOUR', 'MINUTE',
  'SECOND', 'DATE_FORMAT', 'DATE_ADD', 'DATE_SUB', 'DATEDIFF', 'TIMESTAMPDIFF',

  // 条件函数
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'IF', 'IFNULL', 'COALESCE', 'NULLIF',

  // 其他常用
  'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'PRIMARY', 'KEY',
  'FOREIGN', 'REFERENCES', 'CONSTRAINT', 'DEFAULT', 'AUTO_INCREMENT', 'UNSIGNED',
  'ENGINE', 'CHARSET', 'COLLATE', 'COMMENT', 'EXISTS', 'WITH', 'RECURSIVE',
]

function sqlKeywordCompleter(context: CompletionContext): CompletionResult | null {
  // 获取当前光标前的文本
  const textBefore = context.state.doc.sliceString(0, context.pos)

  // 查找当前单词的起始位置（向后查找非单词字符）
  let wordStart = context.pos
  while (wordStart > 0 && /[a-zA-Z_]/.test(textBefore[wordStart - 1])) {
    wordStart--
  }

  const currentWord = textBefore.slice(wordStart, context.pos)

  // 如果当前单词为空或者太短（至少输入1个字符才触发），则不补全
  if (currentWord.length < 1) return null


  // 如果前面紧跟着一个标识符（如 table.column），不触发关键字补全
  if (wordStart > 0) {
    const charBefore = textBefore[wordStart - 1]
    if (/[a-zA-Z0-9_$.]/.test(charBefore)) return null
  }

  // 构建关键字选项
  const options: Completion[] = SQL_KEYWORDS.map(keyword => ({
    label: keyword,
    type: 'keyword' as const,
    detail: 'SQL 关键字',
    info: keyword,
    apply: keyword,
    boost: 99, // 提高优先级
  }))

  return {
    from: wordStart,
    options,
    validFor: /^[a-zA-Z_]*$/,
  }
}

export default function SqlEditor({
  value,
  onChange,
  placeholder = '输入SQL查询...',
  height = '200px',
  dialect = 'mysql',
  readOnly = false,
  tables = {},
  variables = [],
}: SqlEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)

  useEffect(() => {
    if (!editorRef.current) return

    const dialectSchema = dialectMap[dialect] || MySQL

    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        foldGutter(),
        bracketMatching(),
        closeBrackets(),
        autocompletion({
          override: [
            sqlKeywordCompleter,
            ...(variables.length > 0 ? [variableCompleter(variables)] : [])
          ],
          activateOnTyping: true,
        }),
        sql({
          dialect: dialectSchema,
          schema: tables,
          upperCaseKeywords: true,
        }),
        syntaxHighlighting(defaultHighlightStyle),
        cmPlaceholder(placeholder),
        EditorView.lineWrapping,
        keymap.of([...defaultKeymap, indentWithTab]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChange(update.state.doc.toString())
          }
        }),
        EditorView.theme({
          '&': {
            height: height,
            fontSize: '13px',
            backgroundColor: '#fff',
          },
          '.cm-scroller': {
            fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', 'Consolas', monospace",
            overflow: 'auto',
          },
          '.cm-content': {
            padding: '8px 0',
            caretColor: '#333',
          },
          '.cm-line': {
            padding: '0 8px',
          },
          '.cm-gutters': {
            backgroundColor: '#f8f9fa',
            color: '#999',
            border: 'none',
            borderRight: '1px solid #eee',
          },
          '.cm-activeLineGutter': {
            backgroundColor: '#f0f0f0',
            color: '#666',
          },
          '.cm-activeLine': {
            backgroundColor: '#f5f5f5',
          },
          '.cm-selectionBackground': {
            backgroundColor: '#b3d4fc !important',
          },
          '&.cm-focused .cm-selectionBackground': {
            backgroundColor: '#b3d4fc !important',
          },
          '.cm-cursor': {
            borderLeftColor: '#333',
          },
          '.cm-tooltip': {
            backgroundColor: '#fff',
            border: '1px solid #ddd',
            boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
          },
          '.cm-tooltip-autocomplete': {
            '& > ul > li[aria-selected]': {
              backgroundColor: '#e8e8e8',
              color: '#333',
            },
          },
        }),
        EditorState.readOnly.of(readOnly),
      ],
    })

    const view = new EditorView({
      state,
      parent: editorRef.current,
    })

    viewRef.current = view

    return () => {
      view.destroy()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const view = viewRef.current
    if (view && view.state.doc.toString() !== value) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
      })
    }
  }, [value])

  return (
    <div
      ref={editorRef}
      className="sql-editor-container"
      style={{
        border: '1px solid var(--border-color)',
        borderRadius: '4px',
        overflow: 'hidden',
      }}
    />
  )
}
