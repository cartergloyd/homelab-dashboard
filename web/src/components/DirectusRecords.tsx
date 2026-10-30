import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { parseRecordImport } from "../importRecords";
import { Card, ErrorNotice, Modal, useDialog, useToast } from "./ui";
import { Icons } from "./icons";
type Target = { id: string; label: string; url: string };
type Collection = { collection: string; meta?: { singleton?: boolean } };
type Field = {
  field: string;
  type: string;
  schema?: { is_primary_key?: boolean };
  meta?: { hidden?: boolean };
};
type RecordData = Record<string, unknown>;
export function DirectusRecords() {
  const qc = useQueryClient(),
    toast = useToast(),
    { confirm, prompt } = useDialog();
  const [selected, setSelected] = useState(""),
    [collection, setCollection] = useState(""),
    [page, setPage] = useState(1);
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [otp, setOtp] = useState("");
  const [editor, setEditor] = useState<{ id?: string; text: string } | null>(
      null,
    ),
    [imported, setImported] = useState<RecordData[] | null>(null);
  const [fieldEditor, setFieldEditor] = useState(false),
    [fieldName, setFieldName] = useState(""),
    [fieldType, setFieldType] = useState("string");
  const upload = useRef<HTMLInputElement>(null);
  const targets = useQuery({
    queryKey: ["directus-targets"],
    queryFn: () => api.get<Target[]>("/directus/targets"),
  });
  const target = selected || targets.data?.[0]?.id || "",
    root = `/directus/${encodeURIComponent(target)}`;
  const session = useQuery({
    queryKey: ["directus-session", target],
    queryFn: () => api.get<{ connected: boolean }>(`${root}/session`),
    enabled: !!target,
    refetchInterval: 60000,
  });
  const collections = useQuery({
    queryKey: ["directus-collections", target],
    queryFn: () => api.get<Collection[]>(`${root}/collections`),
    enabled: session.data?.connected === true,
  });
  const active =
    collection && collections.data?.some((c) => c.collection === collection)
      ? collection
      : collections.data?.[0]?.collection || "";
  const singleton = collections.data?.find((c) => c.collection === active)?.meta
    ?.singleton;
  const itemPath = `${root}/items/${encodeURIComponent(active)}`;
  const fields = useQuery({
    queryKey: ["directus-fields", target, active],
    queryFn: () =>
      api.get<Field[]>(`${root}/fields/${encodeURIComponent(active)}`),
    enabled: session.data?.connected === true && !!active,
  });
  const records = useQuery({
    queryKey: ["directus-records", target, active, page],
    queryFn: () =>
      api.get<RecordData[] | RecordData>(`${itemPath}?page=${page}`),
    enabled: session.data?.connected === true && !!active,
  });
  const rows = Array.isArray(records.data)
    ? records.data
    : records.data
      ? [records.data]
      : [];
  const primary = fields.data?.find((f) => f.schema?.is_primary_key)?.field;
  const columns =
    fields.data
      ?.filter((f) => !f.meta?.hidden)
      .slice(0, 6)
      .map((f) => f.field) || Object.keys(rows[0] ?? {}).slice(0, 6);
  const done = () => {
    for (const key of [
      "directus-session",
      "directus-collections",
      "directus-records",
      "directus-fields",
    ])
      void qc.invalidateQueries({ queryKey: [key] });
  };
  const error = (e: Error) => toast(e.message, "error");
  const login = useMutation({
    mutationFn: () =>
      api.post(`${root}/login`, { email, password, ...(otp ? { otp } : {}) }),
    onSuccess: done,
    onError: error,
    onSettled: () => {
      setPassword("");
      setOtp("");
    },
  });
  const logout = useMutation({
    mutationFn: () => api.post(`${root}/logout`),
    onSuccess: () => {
      qc.removeQueries({
        predicate: (q) =>
          String(q.queryKey[0]).startsWith("directus-") &&
          q.queryKey[0] !== "directus-targets",
      });
      done();
    },
    onError: error,
  });
  const write = useMutation({
    mutationFn: (request: {
      path: string;
      method?: "patch" | "del";
      body?: unknown;
    }) =>
      request.method === "del"
        ? api.del(request.path)
        : request.method === "patch"
          ? api.patch(request.path, request.body)
          : api.post(request.path, request.body),
    onSuccess: () => {
      done();
      setEditor(null);
      setImported(null);
      setFieldEditor(false);
      toast("Saved in Directus");
    },
    onError: error,
  });
  async function saveRecord() {
    try {
      const body: unknown = JSON.parse(editor!.text);
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new Error("Enter a JSON object.");
      if (
        await confirm({
          title: editor?.id
            ? "Save changes to this record?"
            : `Create a record in ${active}?`,
          confirmLabel: "Save",
        })
      )
        write.mutate({
          path: editor?.id
            ? `${itemPath}/${encodeURIComponent(editor.id)}`
            : itemPath,
          method: editor?.id ? "patch" : undefined,
          body,
        });
    } catch (e) {
      error(e as Error);
    }
  }
  return (
    <Card
      title="Directus"
      actions={
        session.data?.connected && (
          <button
            className="btn sm"
            disabled={logout.isPending}
            onClick={() => logout.mutate()}
          >
            Sign out of Directus
          </button>
        )
      }
    >
      <div className="directus-connection">
        <label htmlFor="directus-instance">Instance</label>
        <select
          id="directus-instance"
          value={target}
          onChange={(e) => {
            setSelected(e.target.value);
            setCollection("");
            setPage(1);
            setEditor(null);
            setImported(null);
          }}
          disabled={write.isPending || login.isPending}
        >
          {targets.data?.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        <span className="muted small">
          {session.data?.connected
            ? "Connected with your Directus permissions"
            : "Sign in with your existing Directus account"}
        </span>
      </div>
      <ErrorNotice
        error={
          targets.error ||
          session.error ||
          collections.error ||
          fields.error ||
          records.error
        }
      />
      {!session.data?.connected ? (
        <form
          className="directus-login"
          onSubmit={(e) => {
            e.preventDefault();
            login.mutate();
          }}
        >
          <label>
            Email
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <label>
            Authenticator code (if enabled)
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
            />
          </label>
          <button className="btn primary" disabled={!target || login.isPending}>
            {login.isPending ? "Connecting…" : "Sign in"}
          </button>
        </form>
      ) : (
        <div className="directus-layout">
          <div className="directus-collections">
            <h3>Collections</h3>
            {collections.data?.map((c) => (
              <button
                key={c.collection}
                className={active === c.collection ? "selected" : ""}
                onClick={() => {
                  setCollection(c.collection);
                  setPage(1);
                }}
              >
                <Icons.database width={14} height={14} />
                {c.collection}
              </button>
            ))}
            <button
              className="btn sm"
              disabled={write.isPending}
              onClick={async () => {
                const name = await prompt({
                  title: "Create collection",
                  label: "Collection name (letters, digits and underscores)",
                  confirmLabel: "Next",
                });
                if (
                  name &&
                  (await confirm({
                    title: `Create ${name}?`,
                    body: "Creates a new database collection with an integer primary key.",
                    confirmLabel: "Create",
                  }))
                )
                  write.mutate({
                    path: `${root}/collections`,
                    body: { collection: name },
                  });
              }}
            >
              + New collection
            </button>
            {collections.data?.length === 0 && (
              <p className="muted small">
                No application collections accessible.
              </p>
            )}
          </div>
          <div className="directus-records">
            {active && (
              <>
                <div className="row spread">
                  <h3>{active}</h3>
                  <div className="row">
                    <button
                      className="btn sm"
                      disabled={write.isPending}
                      onClick={() => setFieldEditor(true)}
                    >
                      Add field
                    </button>
                    <button
                      className="btn sm"
                      disabled={singleton || write.isPending}
                      onClick={() => upload.current?.click()}
                    >
                      Import CSV / JSON
                    </button>
                    <button
                      className="btn primary sm"
                      disabled={singleton || write.isPending}
                      onClick={() => setEditor({ text: "{}" })}
                    >
                      + Record
                    </button>
                  </div>
                </div>
                {singleton && (
                  <p className="muted small">
                    Singleton collection. Open Directus admin for singleton
                    editing.
                  </p>
                )}
                <input
                  type="file"
                  accept=".csv,.json"
                  ref={upload}
                  hidden
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (!file) return;
                    try {
                      if (file.size > 750000)
                        throw new Error("Import up to 750 KB at a time.");
                      setImported(
                        parseRecordImport(await file.text(), file.name),
                      );
                    } catch (e) {
                      error(e as Error);
                    }
                  }}
                />
                <div className="table-scroll">
                  <table className="table">
                    <thead>
                      <tr>
                        {columns.map((c) => (
                          <th key={c}>{c}</th>
                        ))}
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, index) => {
                        const id =
                          primary && r[primary] != null
                            ? String(r[primary])
                            : undefined;
                        return (
                          <tr key={id ?? index}>
                            {columns.map((c) => (
                              <td key={c} className="record-cell">
                                {typeof r[c] === "object"
                                  ? JSON.stringify(r[c])
                                  : String(r[c] ?? "")}
                              </td>
                            ))}
                            <td>
                              <div className="row">
                                <button
                                  className="btn sm"
                                  disabled={!id || singleton || write.isPending}
                                  onClick={() =>
                                    setEditor({
                                      id,
                                      text: JSON.stringify(r, null, 2),
                                    })
                                  }
                                >
                                  Edit
                                </button>
                                <button
                                  className="btn sm danger"
                                  disabled={!id || singleton || write.isPending}
                                  onClick={async () => {
                                    if (
                                      await confirm({
                                        title: `Delete record ${id}?`,
                                        body: `Permanently removes this record from ${active}.`,
                                        confirmLabel: "Delete",
                                        danger: true,
                                      })
                                    )
                                      write.mutate({
                                        path: `${itemPath}/${encodeURIComponent(id!)}`,
                                        method: "del",
                                      });
                                  }}
                                >
                                  Delete
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {records.isPending && <p className="muted">Loading records…</p>}
                {records.data && !rows.length && (
                  <p className="muted">No records on this page.</p>
                )}
                <div className="row spread">
                  <span className="muted small">
                    Page {page} · up to 50 records ·{" "}
                    {fields.data?.length ?? "—"} fields
                  </span>
                  <div className="row">
                    <button
                      className="btn sm"
                      disabled={page === 1}
                      onClick={() => setPage((p) => p - 1)}
                    >
                      Previous
                    </button>
                    <button
                      className="btn sm"
                      disabled={rows.length < 50}
                      onClick={() => setPage((p) => p + 1)}
                    >
                      Next
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {editor && (
        <Modal
          title={editor.id ? `Edit ${active} record` : `New ${active} record`}
          onClose={() => setEditor(null)}
        >
          <div className="stack">
            <p className="muted small">
              Use this collection’s field names. Directus validates types,
              relationships, and permissions.
            </p>
            <textarea
              aria-label="Record JSON"
              rows={16}
              className="json-editor"
              value={editor.text}
              onChange={(e) => setEditor({ ...editor, text: e.target.value })}
              spellCheck={false}
            />
            <ErrorNotice error={write.error} />
            <button
              className="btn primary"
              disabled={write.isPending}
              onClick={() => void saveRecord()}
            >
              Save record
            </button>
          </div>
        </Modal>
      )}
      {imported && (
        <Modal
          title={`Import into ${active}`}
          onClose={() => setImported(null)}
        >
          <p>
            {imported.length} new records. CSV values remain text; Directus
            applies field validation. Existing IDs may cause a conflict. This
            creates records and does not update existing ones.
          </p>
          <pre className="import-preview">
            {JSON.stringify(imported.slice(0, 3), null, 2)}
          </pre>
          <ErrorNotice error={write.error} />
          <button
            className="btn primary"
            disabled={write.isPending}
            onClick={async () => {
              if (
                await confirm({
                  title: `Create ${imported.length} records in ${active}?`,
                  confirmLabel: "Import",
                })
              )
                write.mutate({ path: itemPath, body: imported });
            }}
          >
            Import {imported.length} records
          </button>
        </Modal>
      )}
      {fieldEditor && (
        <Modal
          title={`Add field to ${active}`}
          onClose={() => setFieldEditor(false)}
        >
          <form
            className="stack"
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                await confirm({
                  title: `Add ${fieldName} to ${active}?`,
                  body: `Creates a ${fieldType} field in the database.`,
                  confirmLabel: "Add field",
                })
              )
                write.mutate({
                  path: `${root}/fields/${encodeURIComponent(active)}`,
                  body: { field: fieldName, type: fieldType },
                });
            }}
          >
            <label>
              Field name
              <input
                required
                pattern="[A-Za-z][A-Za-z0-9_]*"
                value={fieldName}
                onChange={(e) => setFieldName(e.target.value)}
              />
            </label>
            <label>
              Type
              <select
                value={fieldType}
                onChange={(e) => setFieldType(e.target.value)}
              >
                {[
                  "string",
                  "text",
                  "integer",
                  "float",
                  "decimal",
                  "boolean",
                  "date",
                  "dateTime",
                  "json",
                  "uuid",
                ].map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </label>
            <ErrorNotice error={write.error} />
            <button className="btn primary" disabled={write.isPending}>
              Add field
            </button>
          </form>
        </Modal>
      )}
    </Card>
  );
}
