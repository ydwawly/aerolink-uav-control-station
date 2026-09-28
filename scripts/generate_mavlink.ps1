$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$python = if ($env:PYTHON) { $env:PYTHON } else { 'python' }
& $python -m pymavlink.tools.mavgen --no-validate --lang=JavaScript_NextGen --wire-protocol=2.0 --output="$root\electron\mavlink\generated.js" "$root\protocol_definitions\common.xml"
& node "$root\scripts\patch-mavlink-generated.cjs"
& $python -m pymavlink.tools.mavgen --no-validate --lang=TypeScript --wire-protocol=2.0 --output="$root\src\protocol\generated" "$root\protocol_definitions\common.xml"
& $python -m pymavlink.tools.mavgen --no-validate --lang=C --wire-protocol=2.0 --output="$root\firmware_reference\third_party\mavlink" "$root\protocol_definitions\common.xml"
Write-Host 'MAVLink 2 JavaScript、TypeScript 和 C 代码已从同一份 common.xml 生成。'
