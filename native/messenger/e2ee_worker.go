package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"go.mau.fi/mautrix-meta/pkg/messagix"
	"go.mau.fi/mautrix-meta/pkg/messagix/table"
	"go.mau.fi/whatsmeow"
	waTypes "go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
)

var privateOutput io.Writer

type reaction struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
	Mine  bool   `json:"mine"`
}
type workerCommand struct {
	ID           string     `json:"id"`
	Mode         string     `json:"mode"`
	Sequence     int64      `json:"sequence"`
	Saved        bool       `json:"saved"`
	ThreadID     string     `json:"threadId"`
	JID          string     `json:"jid"`
	MessageID    string     `json:"messageId"`
	Timestamp    int64      `json:"timestamp"`
	Text         string     `json:"text"`
	ExpectedText string     `json:"expectedText"`
	ReplyTo      string     `json:"replyTo"`
	Emoji        string     `json:"emoji"`
	OperationID  string     `json:"operationId"`
	Approved     bool       `json:"approved"`
	Files        []sendFile `json:"files"`
	Pin          string     `json:"pin"`
}
type encryptedWorker struct {
	ctx        context.Context
	cancel     context.CancelFunc
	client     *messagix.Client
	wa         *whatsmeow.Client
	store      *encryptedStore
	viewer     int64
	output     sync.Mutex
	acks       sync.Map
	sequence   atomic.Int64
	names      map[string]string
	threads    map[string]*thread
	threadLock sync.Mutex
	commands   chan workerCommand
}

func (w *encryptedWorker) emit(value any) bool {
	w.output.Lock()
	defer w.output.Unlock()
	return json.NewEncoder(privateOutput).Encode(value) == nil
}
func (w *encryptedWorker) deliver(m message, t *thread) bool {
	sequence := w.sequence.Add(1)
	ack := make(chan bool, 1)
	w.acks.Store(sequence, ack)
	defer w.acks.Delete(sequence)
	if !w.emit(map[string]any{"type": "message", "sequence": sequence, "message": m, "thread": t}) {
		return false
	}
	select {
	case saved := <-ack:
		return saved
	case <-time.After(30 * time.Second):
		return false
	case <-w.ctx.Done():
		return false
	}
}
func (w *encryptedWorker) response(id string, value map[string]any) {
	value["type"] = "response"
	value["id"] = id
	value["cookies"] = w.client.GetCookies().GetAll()
	w.emit(value)
}
func (w *encryptedWorker) status(code string) {
	w.emit(map[string]any{"type": "status", "code": code, "cookies": w.client.GetCookies().GetAll()})
}
func runEncryptedWorker(client *messagix.Client, initial *table.LSTable, viewer int64, request input) output {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	store, err := openEncryptedStore(ctx, request.StorePath, request.StoreKey)
	if err != nil {
		return output{Error: "encrypted_store_failed"}
	}
	defer store.devices.Close()
	device, err := store.devices.GetFirstDevice(ctx)
	if err != nil {
		return output{Error: "encrypted_store_failed"}
	}
	if device == nil {
		if !request.AllowRegister {
			return output{Error: "device_registration_required"}
		}
		device, err = store.pending(ctx)
		if err != nil {
			return output{Error: "encrypted_store_failed"}
		}
		client.SetDevice(device)
		// The same pending identity is durable before registration. An ambiguous result is never retried automatically.
		if client.RegisterE2EE(ctx, viewer) != nil {
			return output{Error: "device_registration_uncertain"}
		}
		if device.Save(ctx) != nil {
			return output{Error: "device_registration_uncertain"}
		}
		store.db.ExecContext(ctx, `DELETE FROM relay_pending_device WHERE id=1`)
	}
	if device.ID == nil || device.ID.User != strconv.FormatInt(viewer, 10) || device.ID.Server != waTypes.MessengerServer {
		return output{Error: "identity_mismatch"}
	}
	client.SetDevice(device)
	encrypted, err := client.PrepareE2EEClient()
	if err != nil {
		return output{Error: "e2ee_setup_failed"}
	}
	defer encrypted.Disconnect()
	encrypted.SynchronousAck = true
	encrypted.EnableDecryptedEventBuffer = true
	w := &encryptedWorker{ctx: ctx, cancel: cancel, client: client, wa: encrypted, store: store, viewer: viewer, names: map[string]string{}, threads: map[string]*thread{}, commands: make(chan workerCommand, 16)}
	for _, c := range initial.LSDeleteThenInsertContact {
		w.names[strconv.FormatInt(c.Id, 10)] = c.Name
	}
	w.names[strconv.FormatInt(viewer, 10)] = "自分"
	w.initializeThreads(initial)
	catalog := []*thread{}
	for _, t := range w.threads {
		catalog = append(catalog, t)
	}
	w.emit(map[string]any{"type": "catalog", "viewerId": request.ViewerID, "threads": catalog})
	go func() {
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 65536), 145*1024*1024)
		for scanner.Scan() {
			var command workerCommand
			if json.Unmarshal(scanner.Bytes(), &command) != nil {
				w.status("invalid_command")
				continue
			}
			if command.Mode == "ack" {
				if found, ok := w.acks.Load(command.Sequence); ok {
					select {
					case found.(chan bool) <- command.Saved:
					default:
					}
				}
				continue
			}
			if command.Mode == "stop" {
				cancel()
				return
			}
			select {
			case w.commands <- command:
			case <-ctx.Done():
				return
			}
		}
		cancel()
	}()
	encrypted.AddEventHandlerWithSuccessStatus(func(event any) bool {
		switch e := event.(type) {
		case *events.FBMessage:
			return w.receive(e, true)
		case *events.Connected:
			w.emit(map[string]any{"type": "ready", "viewerId": request.ViewerID, "deviceId": device.ID.String(), "historyReady": w.hasHistory(), "cookies": w.client.GetCookies().GetAll()})
		case *events.Disconnected:
			w.status("disconnected")
		case *events.LoggedOut:
			w.status("logged_out")
		case *events.OfflineSyncCompleted:
			w.status("synchronized")
		}
		return true
	})
	if encrypted.Connect() != nil {
		return output{Error: "e2ee_connect_failed"}
	}
	for {
		select {
		case command := <-w.commands:
			w.handle(command)
		case <-ctx.Done():
			return output{OK: true, ViewerID: request.ViewerID}
		}
	}
}
func (w *encryptedWorker) initializeThreads(ls *table.LSTable) {
	for _, t := range normalize(ls, w.viewer).Threads {
		if t.Encrypted {
			w.threads[t.ID] = t
		}
	}
}
func (w *encryptedWorker) threadFor(jid waTypes.JID) *thread {
	w.threadLock.Lock()
	defer w.threadLock.Unlock()
	if t := w.threads[jid.User]; t != nil {
		copy := *t
		return &copy
	}
	title := w.names[jid.User]
	if title == "" {
		title = jid.User
	}
	t := &thread{ID: jid.User, Title: title, IsGroup: jid.Server == waTypes.GroupServer, Encrypted: true, RemoteJID: jid.String(), Members: []string{}}
	w.threads[jid.User] = t
	return t
}

func decorateEncryptedCatalog(ls *table.LSTable, out *output) {
	mapping := map[string]string{}
	for _, m := range ls.LSVerifyHybridThreadExists {
		mapping[strconv.FormatInt(m.ThreadKey, 10)] = strconv.FormatInt(m.ThreadJID, 10)
	}
	for _, m := range ls.LSUpdateThreadAuthorityAndMappingWithOTIDFromJID {
		mapping[strconv.FormatInt(m.ThreadKey, 10)] = strconv.FormatInt(m.ThreadJID, 10)
	}
	jids := map[string]string{}
	for _, t := range out.Threads {
		if !t.Encrypted {
			continue
		}
		original := t.ID
		t.SourceID = original
		if mapped, ok := mapping[original]; ok {
			t.ID = mapped
		}
		server := waTypes.MessengerServer
		if t.IsGroup {
			server = waTypes.GroupServer
		}
		t.RemoteJID = waTypes.NewJID(t.ID, server).String()
		jids[original] = t.RemoteJID
	}
	for i := range out.Messages {
		if jid, ok := jids[out.Messages[i].ThreadID]; ok {
			parsed, e := waTypes.ParseJID(jid)
			if e == nil {
				out.Messages[i].ThreadID = parsed.User
				out.Messages[i].RemoteJID = jid
				if out.Messages[i].Text == "" && len(out.Messages[i].Attachments) == 0 {
					out.Messages[i].Unavailable = true
					out.Messages[i].Text = "暗号化本文の取得を待っています"
				}
			}
		}
	}
}
