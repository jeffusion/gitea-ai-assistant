NAME = ai-code-review
REGISTRY = docker-hosted.nexus.satfabric.com
SHA1 = $(shell git rev-parse HEAD)
REVISION = $(shell git rev-list --count HEAD)
LABELS = --label SHA1=${SHA1} --label REVISION=${REVISION}
VERSION = $(shell ./auto-ver.sh).${REVISION}

OS ?= linux
ARCH ?= amd64

.PHONY: build
build:
	npm run build

.PHONY: container.build
container.build:
	make build
	docker buildx build --platform=${OS}/${ARCH} -t ${REGISTRY}/${NAME}:v${VERSION} ${LABELS} -f Dockerfile .

.PHONY: container.push
container.push:
	make build
	docker buildx build --platform=${OS}/${ARCH} -t ${REGISTRY}/${NAME}:v${VERSION} ${LABELS} -f Dockerfile . --push

.PHONY: k8s.yaml
k8s.yaml:
	cp ./kubernetes.yaml.template ./kubernetes.yaml
	sed -i.bak 's@<%= IMAGE_FROM %>@registry.kuiper.com/${NAME}:v${VERSION}@g' ./kubernetes.yaml
	sed -i.bak 's@<%= APP_NAME %>@${NAME}@g' ./kubernetes.yaml
	rm -f ./kubernetes.yaml.bak

.PHONY: help
help:
	@echo 'Usage: make [target]'

	@echo 'Available targets:'
	@printf "  %-25s %s\n" "container.<build|push>" "本地构建（或构建加推送）容器镜像，若不执行TAG参数，则自动生成VERSION字段"
	@printf "  %-25s %s\n" "k8s.yaml" "生成kubernetes.yaml文件"
	@printf "  %-25s %s\n" "help" "显示此帮助信息"
