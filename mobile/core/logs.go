package libcore

import (
	"io"
	"os"
	"strings"
	"sync"
)

// logRing хранит последние строки журнала mihomo.
type logRing struct {
	mu    sync.Mutex
	lines []string
	next  int
	full  bool
}

func newLogRing(size int) *logRing {
	return &logRing{lines: make([]string, size)}
}

func (r *logRing) Add(line string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.lines[r.next] = line
	r.next = (r.next + 1) % len(r.lines)
	if r.next == 0 {
		r.full = true
	}
}

func (r *logRing) String() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var ordered []string
	if r.full {
		ordered = append(ordered, r.lines[r.next:]...)
	}
	ordered = append(ordered, r.lines[:r.next]...)
	return strings.Join(ordered, "\n")
}

// tailFile читает не больше limit последних байт файла.
func tailFile(path string, limit int64) string {
	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return ""
	}
	offset := info.Size() - limit
	if offset < 0 {
		offset = 0
	}
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		return ""
	}
	data, err := io.ReadAll(file)
	if err != nil {
		return ""
	}
	text := string(data)
	if offset > 0 {
		if index := strings.IndexByte(text, '\n'); index >= 0 {
			text = text[index+1:]
		}
	}
	return strings.TrimRight(text, "\n")
}
