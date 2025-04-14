#!/bin/sh

# 生成基于日期的版本号函数
generate_date_version() {
    date +"%Y.%-m.%-d"
}

# 由于可能允许在detached状态下执行脚本，因此我们允许外部指定HEAD的REF
HEAD_REF_NAME=$1
if [ -z "$HEAD_REF_NAME" ]; then
    HEAD_REF_NAME=$(git rev-parse --abbrev-ref HEAD)
fi
if [ "$HEAD_REF_NAME" = "main" ]; then
    # 对于main分支，使用日期格式的版本号
    generate_date_version
    exit 0
fi
TAG_RECENT=$(git describe --tags --abbrev=0 --match "v*" 2>/dev/null)
if [ -z "$TAG_RECENT" ]; then
    # 无法获取到符合semver格式的tag时，使用日期格式的版本号
    generate_date_version
    exit 0
fi
TAG_COMMIT=$(git log $TAG_RECENT --oneline -1 | awk '{print $1}')
TAG_VERSION=$(echo $TAG_RECENT | tr -d "v")

sub_version_by_type()
{
    type=$1
    field=3
    if [ "$type" = "major" ]; then
        field=1
    elif [ "$type" = "minor" ]; then
        field=2
    else
        field=3
    fi
    echo $TAG_VERSION | awk -F '.' -v field=$field '{print $field}'
}

MAJOR=$(sub_version_by_type major)
MINOR=$(sub_version_by_type minor)
PATCH=$(sub_version_by_type patch)
REVISION_TO_HEAD=$(git rev-list --count $TAG_COMMIT...HEAD)

echo "$MAJOR.$MINOR.$(($PATCH+$REVISION_TO_HEAD))"
