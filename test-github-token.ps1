$token = "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"

$headers = @{
    "Authorization" = "token $token"
    "Accept" = "application/vnd.github.v3+json"
    "User-Agent" = "WebGenie"
}

try {
    $response = Invoke-WebRequest -Uri "https://api.github.com/user" -Headers $headers -ErrorAction Stop
    Write-Host "✅ Token is VALID!"
    Write-Host "Status: $($response.StatusCode)"
    $user = $response.Content | ConvertFrom-Json
    Write-Host "Username: $($user.login)"
} catch {
    Write-Host "❌ Token validation FAILED!"
    Write-Host "Status: $($_.Exception.Response.StatusCode)"
    Write-Host "Error: $($_.Exception.Message)"
    Write-Host "Response: $($_.Exception.Response | ConvertFrom-Json | ConvertTo-Json)"
}
