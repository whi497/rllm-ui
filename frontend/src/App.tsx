import React from 'react';
import { Routes, Route } from 'react-router-dom';
import { Sidebar } from './components/Sidebar';
import { ProjectList } from './components/ProjectList';
import { TrainingRunDetail } from './components/TrainingRunDetail';
import { ProjectOverview } from './components/ProjectOverview';
import { SettingsPage } from './components/SettingsPage';
import { ExperimentVisibilityProvider } from './contexts/ExperimentVisibilityContext';
import { AuthProvider } from './contexts/AuthContext';
import { AuthGuard } from './components/auth/AuthGuard';

const App: React.FC = () => {
  return (
    <AuthProvider>
      <AuthGuard>
        <ExperimentVisibilityProvider>
          <div className="flex w-full h-screen overflow-hidden bg-layer-1">
            <Sidebar />
            <main className="flex-1 flex flex-col overflow-hidden bg-layer-1">
              <Routes>
                <Route path="/" element={<ProjectList />} />
                <Route path="/project/:projectId" element={<ProjectOverview />} />
                <Route path="/runs/:sessionId" element={<TrainingRunDetail />} />
                <Route path="/settings" element={<SettingsPage />} />
              </Routes>
            </main>
          </div>
        </ExperimentVisibilityProvider>
      </AuthGuard>
    </AuthProvider>
  );
};

export default App;
