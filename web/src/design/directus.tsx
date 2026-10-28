import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { parseRecordImport } from "../importRecords";
import { useDialog, useToast } from "../components/ui";
import { Button, Empty, Icon, Issue, Panel, Status, Table } from "./ui";
import { Drawer } from "./shared";
import { FileStore } from "./storage";

type Target = { id: string; label: string; url: string };
type Collection = { collection: string; meta?: { singleton?: boolean } };
type Field = {
  field: string;
  type: string;
  schema?: { is_primary_key?: boolean };
  meta?: { hidden?: boolean };
};
type RecordData = Record<string, unknown>;
export function DirectusDesign({
  workspace = "personal",
}: {
  workspace?: "personal" | "business";
}) {
  const [connecting, setConnecting] = useState(false),
    [files, setFiles] = useState<"upload" | "browse" | null>(null);
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
  const target =
      selected ||
      targets.data?.find(
        (t) => t.id === (workspace === "business" ? "ai" : "personal"),
      )?.id ||
      targets.data?.[0]?.id ||
      "",
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
    onSuccess: () => {
      done();
      setConnecting(false);
    },
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
    <Panel
      title="Directus"
      className="directus-panel"
      actions={
        <Status
          label={session.data?.connected ? "Connected" : "Sign in for records"}
          state={session.data?.connected ? "ok" : "unknown"}
        />
      }
    >
      <div className="directus-connection">
        <span>
          Instance{" "}
          <code>
            {targets.data?.find((t) => t.id === target)?.url ?? "Checking"}
          </code>
        </span>
        <span>{targets.data?.find((t) => t.id === target)?.label}</span>
        <Button icon="pulse" onClick={() => setConnecting(true)}>
          Connection settings
        </Button>
      </div>
      <div className="panel-body file-grid">
        <Button icon="upload" primary onClick={() => setFiles("upload")}>
          Upload files
        </Button>
        <Button
          icon="database"
          disabled={write.isPending}
          onClick={async () => {
            if (!session.data?.connected) {
              setConnecting(true);
              return;
            }
            const name = await prompt({
              title: "New collection",
              label: "Collection name (letters, numbers and underscores)",
              confirmLabel: "Next",
            });
            if (
              name &&
              (await confirm({
                title: `Create ${name}?`,
                body: "Creates a collection with an integer primary key in this Directus instance.",
                confirmLabel: "Create",
              }))
            )
              write.mutate({
                path: `${root}/collections`,
                body: { collection: name },
              });
          }}
        >
          New collection
        </Button>
        <Button icon="folder" onClick={() => setFiles("browse")}>
          Files
        </Button>
      </div>
      <Issue
        error={
          targets.error ||
          session.error ||
          collections.error ||
          fields.error ||
          records.error
        }
      />
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
              <Icon name="database" />
              {c.collection}
            </button>
          ))}
          {!session.data?.connected && (
            <p className="inline-note">Sign in to view your collections.</p>
          )}
          {collections.data?.length === 0 && (
            <p className="inline-note">No application collections found.</p>
          )}
        </div>
        <div className="directus-records-content">
          {active && session.data?.connected ? (
            <>
              <div className="section-label">
                <h3>{active}</h3>
                <div className="head-actions">
                  <Button
                    icon="plus"
                    disabled={singleton || write.isPending}
                    onClick={() => setEditor({ text: "{}" })}
                  >
                    Add record
                  </Button>
                  <Button
                    icon="upload"
                    disabled={singleton || write.isPending}
                    onClick={() => upload.current?.click()}
                  >
                    Import CSV / JSON
                  </Button>
                  <Button icon="database" onClick={() => setFieldEditor(true)}>
                    Add field
                  </Button>
                </div>
              </div>
              <Table headers={[...columns, ""]}>
                {rows.map((r, i) => {
                  const id =
                    primary && r[primary] != null
                      ? String(r[primary])
                      : undefined;
                  return (
                    <tr key={id ?? i}>
                      {columns.map((c) => (
                        <td key={c} className="record-cell">
                          {typeof r[c] === "object"
                            ? JSON.stringify(r[c])
                            : String(r[c] ?? "")}
                        </td>
                      ))}
                      <td>
                        <div className="table-actions">
                          <Button
                            disabled={!id || singleton || write.isPending}
                            onClick={() =>
                              setEditor({
                                id,
                                text: JSON.stringify(r, null, 2),
                              })
                            }
                          >
                            Edit
                          </Button>
                          <button
                            className="icon-button"
                            aria-label={`Delete record ${id}`}
                            disabled={!id || singleton || write.isPending}
                            onClick={async () => {
                              if (
                                await confirm({
                                  title: `Delete record ${id}?`,
                                  body: "This permanently removes the record.",
                                  danger: true,
                                  confirmLabel: "Delete",
                                })
                              )
                                write.mutate({
                                  path: `${itemPath}/${encodeURIComponent(id!)}`,
                                  method: "del",
                                });
                            }}
                          >
                            <Icon name="trash" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </Table>
              {records.data && !rows.length && (
                <Empty>No records in this collection.</Empty>
              )}
              <div className="panel-bottom">
                <span>Page {page}</span>
                <div className="head-actions">
                  <Button
                    disabled={page === 1}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    Previous
                  </Button>
                  <Button
                    disabled={rows.length < 50}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>
              {singleton && (
                <p className="inline-note">
                  Singleton editing is available in Directus admin.
                </p>
              )}
            </>
          ) : (
            <Empty>
              {session.data?.connected
                ? "Select a collection to view records."
                : "Connect your Directus account to browse and edit records."}
            </Empty>
          )}
        </div>
      </div>
      <div className="panel-bottom">
        <span>
          {session.data?.connected
            ? "Using your existing Directus permissions"
            : "File uploads use the configured private file connection"}
        </span>
      </div>
      <input
        ref={upload}
        type="file"
        accept=".csv,.json"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          try {
            if (file.size > 750000)
              throw new Error("Import up to 750 KB at a time.");
            setImported(parseRecordImport(await file.text(), file.name));
          } catch (e) {
            error(e as Error);
          }
        }}
      />
      {connecting && (
        <Drawer
          title="Directus connection"
          onClose={() => setConnecting(false)}
        >
          <form
            className="form-stack"
            onSubmit={(e) => {
              e.preventDefault();
              login.mutate();
            }}
          >
            <label className="field">
              Instance
              <select
                value={target}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setCollection("");
                  setPage(1);
                  setEditor(null);
                  setImported(null);
                }}
                disabled={login.isPending || write.isPending}
              >
                {targets.data?.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label} · {t.url}
                  </option>
                ))}
              </select>
            </label>
            <p className="inline-note">
              Sign in with your existing Directus account. Your token stays on
              the server.
            </p>
            {session.data?.connected ? (
              <>
                <Status label="Connected" state="ok" />
                <Button
                  type="button"
                  disabled={logout.isPending}
                  onClick={() => logout.mutate()}
                >
                  Sign out of Directus
                </Button>
              </>
            ) : (
              <>
                <label className="field">
                  Email
                  <input
                    type="email"
                    autoComplete="username"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </label>
                <label className="field">
                  Password
                  <input
                    type="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
                <label className="field">
                  Authenticator code (if enabled)
                  <input
                    inputMode="numeric"
                    maxLength={6}
                    autoComplete="one-time-code"
                    value={otp}
                    onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                  />
                </label>
                <Issue error={login.error} />
                <Button primary disabled={login.isPending || !target}>
                  {login.isPending ? "Connecting…" : "Sign in"}
                </Button>
              </>
            )}
          </form>
        </Drawer>
      )}
      {files && (
        <Drawer title="Private files & uploads" onClose={() => setFiles(null)}>
          <FileStore initialTarget={target} autoPick={files === "upload"} />
        </Drawer>
      )}
      {editor && (
        <Drawer
          title={editor.id ? `Edit ${active} record` : `Add ${active} record`}
          onClose={() => setEditor(null)}
        >
          <div className="form-stack">
            <label className="field">
              Record JSON
              <textarea
                className="json-editor"
                rows={14}
                spellCheck={false}
                value={editor.text}
                onChange={(e) => setEditor({ ...editor, text: e.target.value })}
              />
            </label>
            <Issue error={write.error} />
            <Button
              primary
              disabled={write.isPending}
              onClick={() => void saveRecord()}
            >
              Save record
            </Button>
          </div>
        </Drawer>
      )}
      {imported && (
        <Drawer
          title={`Import into ${active}`}
          onClose={() => setImported(null)}
        >
          <p className="inline-note">
            {imported.length} new records. CSV values remain text; Directus
            validates the field types. Existing IDs are not overwritten.
          </p>
          <pre
            style={{ whiteSpace: "pre-wrap", maxHeight: 280, overflow: "auto" }}
          >
            {JSON.stringify(imported.slice(0, 3), null, 2)}
          </pre>
          <Issue error={write.error} />
          <Button
            primary
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
          </Button>
        </Drawer>
      )}
      {fieldEditor && (
        <Drawer
          title={`Add field to ${active}`}
          onClose={() => setFieldEditor(false)}
        >
          <form
            className="form-stack"
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                await confirm({
                  title: `Add ${fieldName} to ${active}?`,
                  body: `Creates a ${fieldType} database field.`,
                  confirmLabel: "Add field",
                })
              )
                write.mutate({
                  path: `${root}/fields/${encodeURIComponent(active)}`,
                  body: { field: fieldName, type: fieldType },
                });
            }}
          >
            <label className="field">
              Field name
              <input
                required
                pattern="[A-Za-z][A-Za-z0-9_]*"
                value={fieldName}
                onChange={(e) => setFieldName(e.target.value)}
              />
            </label>
            <label className="field">
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
            <Issue error={write.error} />
            <Button primary disabled={write.isPending}>
              Add field
            </Button>
          </form>
        </Drawer>
      )}
    </Panel>
  );
}
