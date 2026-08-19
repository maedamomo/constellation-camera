# 第三者のデータとライセンス

このプロジェクト自体は MIT ライセンス（`LICENSE`）だが、星表データだけは第三者に由来する。

`src/data.js` は `tools/build-data.mjs` が d3-celestial の配布データから生成した二次データで、
`index.html` にはそれがそのまま埋め込まれている。したがって **`index.html` を 1 枚配るだけでも
下記の BSD-3-Clause の再配布条件がかかる**。`index.html` のフッターにも出典を表示しているが、
条件の全文は以下に収録する。

## d3-celestial

- 出典: https://github.com/ofrohn/d3-celestial
- 使用箇所: `src/data.js`（恒星の位置と等級、星座線、星座名、恒星の日本語名）
- 元データ: 恒星は Hipparcos カタログ、星座の境界と線は IAU の定義

```
BSD 3-Clause License

Copyright (c) 2015, Olaf Frohn
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

3. "Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products" without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## Hipparcos カタログ

恒星の位置と等級の元をたどると ESA の Hipparcos ミッション（1997）の成果物にあたる。
学術データとして自由に利用できるが、由来の表示は残している。

- ESA, *The Hipparcos and Tycho Catalogues*, ESA SP-1200 (1997)
