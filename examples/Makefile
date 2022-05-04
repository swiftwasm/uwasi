build/swift.wasm:
	swiftc -target wasm32-unknown-wasi languages/swift/main.swift -o build/swift.wasm

build/ruby.wasm:
	mkdir -p build/ruby
	cd build/ruby && curl -L curl -L https://github.com/ruby/ruby.wasm/releases/download/2022-05-03-a/ruby-head-wasm32-unknown-wasi-minimal.tar.gz | tar xz --strip-components=1
	mv build/ruby/usr/local/bin/ruby build/ruby.wasm
	rm -rf build/ruby

build/rust.wasm:
	rustc --target wasm32-wasi languages/rust/main.rs -o build/rust.wasm

build/c.wasm:
	clang -target wasm32-wasi languages/c/main.c -o build/c.wasm

.PHONY: all
all: build/swift.wasm build/ruby.wasm build/rust.wasm
