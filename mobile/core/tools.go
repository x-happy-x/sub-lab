//go:build tools

// Держит golang.org/x/mobile в go.mod: без него `gomobile bind` не соберёт .aar.
package libcore

import _ "golang.org/x/mobile/bind"
