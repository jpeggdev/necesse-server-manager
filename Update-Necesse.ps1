# ==========================================
# CONFIGURATION - CHANGE THESE PATHS
# ==========================================
$SteamCMDPath   = "C:\steamcmd\steamcmd.exe"
$ServerModsDir  = "C:\Servers\Necesse\mods"

# Put your 10 Mod IDs inside the array below, separated by commas
$ModIDs = @(
    3531458136,
    3694501995,
    3743512839,
    3648675157,
    3731244177
)
# ==========================================

# 1. Build the SteamCMD arguments dynamically
Write-Host "Configuring SteamCMD arguments..." -ForegroundColor Cyan
$SteamArgs = @("+login", "anonymous")

foreach ($ModID in $ModIDs) {
    $SteamArgs += "+workshop_download_item"
    $SteamArgs += "1169040"
    $SteamArgs += $ModID
}
$SteamArgs += "+quit"

# 2. Run SteamCMD to fetch updates
Write-Host "Launching SteamCMD to download/update mods..." -ForegroundColor Cyan
Start-Process -FilePath $SteamCMDPath -ArgumentList $SteamArgs -Wait -NoNewWindow

# 3. Figure out where SteamCMD saved them
$SteamCMDFolder = Split-Path -Parent $SteamCMDPath
$WorkshopDir = Join-Path $SteamCMDFolder "steamapps\workshop\content\1169040"

if (-not (Test-Path $WorkshopDir)) {
    Write-Error "SteamCMD workshop directory not found. Did the download fail?"
    Pause; exit
}

# Ensure destination mod directory exists
if (-not (Test-Path $ServerModsDir)) {
    New-Item -ItemType Directory -Path $ServerModsDir | Out-Null
}

# 4. Automatically find and copy all .jar files
Write-Host "`nScanning and transferring .jar files to server..." -ForegroundColor Cyan

foreach ($ModID in $ModIDs) {
    $ModFolder = Join-Path $WorkshopDir $ModID
    if (Test-Path $ModFolder) {
        # Find any .jar files inside this mod's folder
        $JarFiles = Get-ChildItem -Path $ModFolder -Filter "*.jar" -Recurse
        
        foreach ($File in $JarFiles) {
            $DestFile = Join-Path $ServerModsDir $File.Name
            Write-Host "Copying: $($File.Name) -> $ServerModsDir" -ForegroundColor Yellow
            Copy-Item -Path $File.FullName -Destination $DestFile -Force
        }
    } else {
        Write-Host "Warning: Mod folder for ID $ModID was not found!" -ForegroundColor Red
    }
}

Write-Host "`nAll mods updated and deployed successfully!" -ForegroundColor Green
Pause
