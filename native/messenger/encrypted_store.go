package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/google/uuid"
	_ "github.com/ncruces/go-sqlite3/driver"
	_ "github.com/ncruces/go-sqlite3/vfs/adiantum"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/util/keys"
)

type pendingDevice struct {
	Noise        [32]byte  `json:"noise"`
	Identity     [32]byte  `json:"identity"`
	Signed       [32]byte  `json:"signed"`
	Signature    [64]byte  `json:"signature"`
	KeyID        uint32    `json:"key_id"`
	Registration uint32    `json:"registration"`
	Secret       []byte    `json:"secret"`
	UUID         uuid.UUID `json:"uuid"`
}
type encryptedStore struct {
	db      *sql.DB
	devices *sqlstore.Container
}

func openEncryptedStore(ctx context.Context, path, key string) (*encryptedStore, error) {
	if !filepath.IsAbs(path) || !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(key) {
		return nil, errors.New("invalid_store_configuration")
	}
	uriPath := filepath.ToSlash(path)
	if filepath.VolumeName(path) != "" && !strings.HasPrefix(uriPath, "/") {
		uriPath = "/" + uriPath
	}
	source := url.URL{Scheme: "file", Path: uriPath}
	q := url.Values{"vfs": {"adiantum"}, "hexkey": {key}, "_pragma": {"foreign_keys(1)", "temp_store(memory)", "journal_mode(DELETE)", "synchronous(FULL)", "busy_timeout(5000)"}}
	source.RawQuery = q.Encode()
	db, err := sql.Open("sqlite3", source.String())
	if err != nil {
		return nil, errors.New("encrypted_store_failed")
	}
	db.SetMaxOpenConns(1)
	container := sqlstore.NewWithDB(db, "sqlite3", nil)
	if container.Upgrade(ctx) != nil {
		db.Close()
		return nil, errors.New("encrypted_store_failed")
	}
	for _, statement := range []string{
		`CREATE TABLE IF NOT EXISTS relay_pending_device (id INTEGER PRIMARY KEY CHECK(id=1), value BLOB NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS relay_messages (thread_id TEXT NOT NULL,id TEXT NOT NULL,ts INTEGER NOT NULL,event BLOB NOT NULL,wire BLOB NOT NULL,PRIMARY KEY(thread_id,id))`,
		`CREATE TABLE IF NOT EXISTS relay_controls (thread_id TEXT NOT NULL,target TEXT NOT NULL,actor TEXT NOT NULL,kind TEXT NOT NULL,ts INTEGER NOT NULL,payload BLOB NOT NULL,PRIMARY KEY(thread_id,target,actor,kind))`,
		`CREATE TABLE IF NOT EXISTS relay_private (name TEXT PRIMARY KEY,value BLOB NOT NULL)`,
	} {
		if _, err = db.ExecContext(ctx, statement); err != nil {
			db.Close()
			return nil, errors.New("encrypted_store_failed")
		}
	}
	return &encryptedStore{db: db, devices: container}, nil
}
func (s *encryptedStore) pending(ctx context.Context) (*store.Device, error) {
	var data []byte
	err := s.db.QueryRowContext(ctx, `SELECT value FROM relay_pending_device WHERE id=1`).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		device := s.devices.NewDevice()
		device.FacebookUUID = uuid.New()
		p := pendingDevice{Noise: *device.NoiseKey.Priv, Identity: *device.IdentityKey.Priv, Signed: *device.SignedPreKey.Priv, Signature: *device.SignedPreKey.Signature, KeyID: device.SignedPreKey.KeyID, Registration: device.RegistrationID, Secret: device.AdvSecretKey, UUID: device.FacebookUUID}
		data, _ = json.Marshal(p)
		_, err = s.db.ExecContext(ctx, `INSERT INTO relay_pending_device(id,value) VALUES(1,?)`, data)
		if err != nil {
			return nil, err
		}
		return device, nil
	}
	if err != nil {
		return nil, err
	}
	var p pendingDevice
	if json.Unmarshal(data, &p) != nil {
		return nil, errors.New("invalid_pending_device")
	}
	device := s.devices.NewDevice()
	device.NoiseKey = keys.NewKeyPairFromPrivateKey(p.Noise)
	device.IdentityKey = keys.NewKeyPairFromPrivateKey(p.Identity)
	device.SignedPreKey = &keys.PreKey{KeyPair: *keys.NewKeyPairFromPrivateKey(p.Signed), KeyID: p.KeyID, Signature: &p.Signature}
	device.RegistrationID = p.Registration
	device.AdvSecretKey = p.Secret
	device.FacebookUUID = p.UUID
	return device, nil
}
func (s *encryptedStore) putPrivate(ctx context.Context, name string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO relay_private(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value`, name, data)
	return err
}
func (s *encryptedStore) private(ctx context.Context, name string, out any) error {
	var data []byte
	if err := s.db.QueryRowContext(ctx, `SELECT value FROM relay_private WHERE name=?`, name).Scan(&data); err != nil {
		return err
	}
	return json.Unmarshal(data, out)
}
